/**
 * Shared internals for the LLM provider adapters (Req 13.5, 14.1, 14.5, 17.4).
 *
 * This module is deliberately NOT an adapter — it is the common transport,
 * resilience, and validation machinery that the three adapters
 * (`openai.ts`, `anthropic.ts`, `gemini.ts`) reuse so that rate-limit handling,
 * exponential backoff, throttle-wait measurement, JSON extraction, schema
 * validation, and `llm_call` trace emission are implemented exactly once rather
 * than copied per provider. Keeping it here also lets `openai.ts` stay a thin,
 * transport-only file that `index.ts` can construct twice (`openai` and
 * `openrouter`) without a fourth adapter file.
 *
 * The single LLM entry point remains `completeJson`, which returns a value that
 * has already been validated against the caller's Zod schema, or throws a typed
 * {@link LlmValidationError}. That typed boundary is what makes the bounded,
 * feedback-driven retry in Requirement 17.4 implementable by the orchestrator.
 */

import type { ZodType } from "zod";

import type { LlmThrottle, Maybe } from "../../agent/contracts";
import { UNKNOWN } from "../../agent/contracts";

// ---------------------------------------------------------------------------
// Typed error at the validation boundary (Req 17.4)
// ---------------------------------------------------------------------------

export type LlmValidationErrorKind =
  | "schema" // model output parsed as JSON but violated the Zod schema
  | "parse" // model output was not valid JSON
  | "rate_limit" // 429s persisted past the honored delay + backoff retries
  | "transport"; // non-2xx (non-429) response or network/transport failure

/**
 * The single error type surfaced by every adapter's `completeJson`. The
 * orchestrator catches this to drive its three-attempt budget: a `schema`
 * failure carries `issues` that become the next attempt's validation feedback,
 * while a `rate_limit` exhaustion degrades the stage like any other LLM failure
 * (Req 17.6) — no new failure mode.
 */
export class LlmValidationError extends Error {
  readonly kind: LlmValidationErrorKind;
  readonly provider: string;
  readonly model: string;
  /** Human-readable Zod issues, present when `kind === "schema"`. */
  readonly issues: string[] | undefined;
  /** HTTP status, present for transport/rate-limit failures. */
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    opts: {
      kind: LlmValidationErrorKind;
      provider: string;
      model: string;
      issues?: string[];
      statusCode?: number;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmValidationError";
    this.kind = opts.kind;
    this.provider = opts.provider;
    this.model = opts.model;
    this.issues = opts.issues;
    this.statusCode = opts.statusCode;
  }
}

// ---------------------------------------------------------------------------
// llm_call trace — mapped 1:1 by the orchestrator to a StageEvent.llmCall
// ---------------------------------------------------------------------------

/**
 * What an adapter reports for a single `llm_call` observation. The adapter does
 * not know the current stage or the orchestrator's attempt number, so it emits
 * this decoupled trace and the orchestrator injects `stage`, `stageName`,
 * `attempt`, `seq`, `eventId`, `runId`, and `timestamp` when it builds the
 * concrete {@link StageEvent}. The field set mirrors `StageEvent.llmCall`
 * exactly (throttled/throttleWaitMs, rateLimited/retryAfterMs,
 * fallbackModelUsed, and the serving model).
 */
export interface LlmCallTrace {
  purpose: string;
  provider: string;
  /** The model that actually served (or is about to serve) the call. */
  model: string;
  message: string;
  promptTokens: Maybe<number>;
  completionTokens: Maybe<number>;
  fallbackModelUsed: boolean;
  throttled: boolean;
  throttleWaitMs?: number;
  rateLimited: boolean;
  retryAfterMs?: Maybe<number>;
  durationMs?: number;
}

export type LlmCallEmitter = (trace: LlmCallTrace) => void;

// ---------------------------------------------------------------------------
// Injectable dependencies (throttle is the shared chokepoint; clock/fetch for tests)
// ---------------------------------------------------------------------------

export interface LlmAdapterDeps {
  /** The single shared RPM queue every adapter routes its transport through. */
  throttle: LlmThrottle;
  /** Optional sink for `llm_call` traces; the orchestrator wires this per run. */
  emit?: LlmCallEmitter;
  /** Injected clock (defaults to Date.now) — lets tests drive backoff/Retry-After. */
  now?: () => number;
  /** Injected sleeper (defaults to a real timer) — lets tests skip real waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected transport (defaults to global fetch) — lets tests assert requests. */
  fetchImpl?: typeof fetch;
}

/** Common construction shape for every adapter. `openai`/`openrouter` share it. */
export interface BaseAdapterConfig {
  name: "openai" | "anthropic" | "gemini" | "openrouter";
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel: Maybe<string>;
  extraHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Rate-limit retries per single `completeJson` invocation (task 2.1). */
export const MAX_RATE_LIMIT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

// ---------------------------------------------------------------------------
// Retry-After parsing (seconds form and HTTP-date form) — task 2.9 targets this
// ---------------------------------------------------------------------------

/**
 * Parses an HTTP `Retry-After` header into milliseconds.
 *
 * Supports both wire forms:
 *  - delay-seconds, e.g. `"120"` → `120_000`
 *  - HTTP-date, e.g. `"Wed, 21 Oct 2015 07:28:00 GMT"` → `date - now`, floored at 0
 *
 * An absent, empty, or unparseable value returns `null`, which the caller reads
 * as "fall straight through to exponential backoff".
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: () => number,
): number | null {
  if (headerValue === null || headerValue === undefined) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;

  // delay-seconds form (RFC 9110): a non-negative integer number of seconds.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  // HTTP-date form: parse and take the (non-negative) delta from now.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - now();
  return delta > 0 ? delta : 0;
}

/** Exponential backoff for retry index 0,1,... capped, used when Retry-After is absent. */
export function backoffDelayMs(retryIndex: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** retryIndex;
  return Math.min(exp, BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------------------
// JSON extraction + schema validation at the boundary
// ---------------------------------------------------------------------------

/**
 * Extracts a JSON document from raw model text, tolerating a leading ```json
 * (or bare ```) code fence that some models wrap structured output in.
 */
export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/s, "");
    return withoutFence.trim();
  }
  return trimmed;
}

/**
 * Parses `raw` as JSON and validates it against `schema`, throwing a typed
 * {@link LlmValidationError} (`parse` or `schema`) on failure so the caller sees
 * a single boundary error rather than a downstream surprise.
 */
export function parseAndValidate<T>(
  raw: string,
  schema: ZodType<T>,
  provider: string,
  model: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (cause) {
    throw new LlmValidationError("Model response was not valid JSON.", {
      kind: "parse",
      provider,
      model,
      cause,
    });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new LlmValidationError("Model output failed schema validation.", {
      kind: "schema",
      provider,
      model,
      issues,
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Resilient transport: throttle wrap + Retry-After + bounded backoff
// ---------------------------------------------------------------------------

/** Normalized usage the extractors return; adapters map their provider shape into this. */
export interface RawCompletion {
  text: string;
  promptTokens: Maybe<number>;
  completionTokens: Maybe<number>;
}

/**
 * Runs one logical model call through the shared throttle, then through the
 * rate-limit resilience loop, and returns the extracted completion text +
 * usage. Emits `llm_call` traces for throttle waits, each honored rate-limit
 * delay, and the final served call. Schema validation happens in the caller
 * (`completeJson`) so a slot is not held during CPU-bound parsing.
 *
 * @param performRequest issues one transport request and resolves the Response.
 * @param extract        maps a 2xx Response body to {@link RawCompletion}.
 */
export async function scheduleModelCall(params: {
  deps: Required<Pick<LlmAdapterDeps, "throttle">> & LlmAdapterDeps;
  provider: string;
  model: string;
  purpose: string;
  fallbackModelUsed: boolean;
  performRequest: () => Promise<Response>;
  extract: (response: Response) => Promise<RawCompletion>;
}): Promise<RawCompletion> {
  const { deps, provider, model, purpose, fallbackModelUsed } = params;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emit = deps.emit;

  const submittedAt = now();

  return deps.throttle.schedule(purpose, async () => {
    const startedAt = now();
    const throttleWaitMs = Math.max(0, startedAt - submittedAt);

    // Visible in the trace so a reviewer sees queuing, not hanging.
    if (throttleWaitMs > 0) {
      emit?.({
        purpose,
        provider,
        model,
        message: `LLM call "${purpose}" waited ${throttleWaitMs}ms on the RPM queue.`,
        promptTokens: UNKNOWN,
        completionTokens: UNKNOWN,
        fallbackModelUsed,
        throttled: true,
        throttleWaitMs,
        rateLimited: false,
      });
    }

    let rateLimited = false;

    for (let retryIndex = 0; ; retryIndex++) {
      const response = await params.performRequest();

      if (response.status !== 429) {
        if (!response.ok) {
          throw new LlmValidationError(
            `Transport error from ${provider}: HTTP ${response.status}.`,
            { kind: "transport", provider, model, statusCode: response.status },
          );
        }
        const completion = await params.extract(response);
        emit?.({
          purpose,
          provider,
          model,
          message: `LLM call "${purpose}" served by ${model}.`,
          promptTokens: completion.promptTokens,
          completionTokens: completion.completionTokens,
          fallbackModelUsed,
          throttled: throttleWaitMs > 0,
          throttleWaitMs: throttleWaitMs > 0 ? throttleWaitMs : undefined,
          rateLimited,
          durationMs: Math.max(0, now() - startedAt),
        });
        return completion;
      }

      // Rate limited. Two retries, honoring Retry-After before blind backoff.
      if (retryIndex >= MAX_RATE_LIMIT_RETRIES) {
        throw new LlmValidationError(
          `Rate limit persisted for ${provider} after ${MAX_RATE_LIMIT_RETRIES} retries.`,
          { kind: "rate_limit", provider, model, statusCode: 429 },
        );
      }

      rateLimited = true;
      const honored = parseRetryAfter(response.headers.get("retry-after"), now);
      const waitMs = honored ?? backoffDelayMs(retryIndex);
      emit?.({
        purpose,
        provider,
        model,
        message:
          honored !== null
            ? `LLM call "${purpose}" hit a rate limit; honoring Retry-After ${waitMs}ms.`
            : `LLM call "${purpose}" hit a rate limit; backing off ${waitMs}ms.`,
        promptTokens: UNKNOWN,
        completionTokens: UNKNOWN,
        fallbackModelUsed,
        throttled: throttleWaitMs > 0,
        throttleWaitMs: throttleWaitMs > 0 ? throttleWaitMs : undefined,
        rateLimited: true,
        retryAfterMs: honored ?? UNKNOWN,
      });
      await sleep(waitMs);
    }
  });
}

/** Resolves the serving model + fallback flag for a `completeJson` invocation. */
export function resolveServingModel(
  primaryModel: string,
  fallbackModel: Maybe<string>,
  useFallbackModel: boolean | undefined,
): { model: string; fallbackModelUsed: boolean } {
  if (useFallbackModel === true && fallbackModel !== UNKNOWN) {
    return { model: fallbackModel, fallbackModelUsed: true };
  }
  return { model: primaryModel, fallbackModelUsed: false };
}
