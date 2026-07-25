/**
 * Secret redaction — defense in depth for Req 14.5 (secrets never leave the
 * server) and the run-trace/artifact fan-out (Req 11.6).
 *
 * The orchestrator runs {@link redactStageEvent} over EVERY StageEvent at the
 * single `emit` chokepoint before it is fanned out to the SSE sink and appended
 * to the artifact's event array, and runs {@link redactArtifact} over the whole
 * artifact before it is returned/persisted. No stage or provider is supposed to
 * place a secret in an event in the first place; this pass guarantees it anyway
 * (design "Secret handling and redaction" section, Property 33).
 *
 * Two complementary strategies run over every string, both applied by a deep
 * walk that is robust to unknown/object output shapes (`StageEvent.output` is
 * typed `unknown`):
 *
 *  1. Exact match on the CONFIGURED provider keys (the real secrets for this
 *     process, read name-safely via {@link collectSecretsFromEnv}). This is the
 *     strongest signal: a sentinel key injected into `process.env` is scrubbed
 *     wherever it appears, however it was serialized.
 *  2. Pattern match on secret-LOOKING substrings — `Bearer <token>` strings and
 *     `sk-…` style API keys (OpenAI `sk-`, Anthropic `sk-ant-`, OpenRouter
 *     `sk-or-v1-` all share the `sk-` prefix) — so a leaked credential is caught
 *     even when it is not one of this process's configured keys.
 *
 * Every match is replaced with {@link REDACTION_PLACEHOLDER}. The functions are
 * pure: they return redacted copies and never mutate their argument, so the
 * caller can redact just before hand-off without disturbing in-flight state.
 */

import type { RunArtifact, StageEvent } from "./contracts";

import { getConfig } from "@/lib/config/env";

/** The literal substituted for any redacted secret substring. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * A configured secret shorter than this is not exact-matched, because a very
 * short "key" would match innocuous substrings all over the trace and corrupt
 * it. Real provider keys are far longer than this floor.
 */
const MIN_EXACT_SECRET_LENGTH = 6;

/** `Bearer <token>` → `Bearer [REDACTED]` (case-insensitive scheme). */
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** `sk-…` API keys (OpenAI/Anthropic/OpenRouter share the `sk-` prefix). */
const SK_KEY_PATTERN = /sk-[A-Za-z0-9._-]{8,}/g;

/**
 * Reads the CONFIGURED provider secrets for this process so they can be exact-
 * matched during redaction. Returns an empty list — never throws — when the
 * environment is not (yet) valid, so redaction still runs its pattern pass on a
 * run that failed env validation. Only true secrets are returned; the Upstash
 * REST *URL* is not a secret and is deliberately omitted, while its *token* is.
 */
export function collectSecretsFromEnv(): string[] {
  try {
    const config = getConfig();
    const secrets: string[] = [];
    if (config.llmApiKey) secrets.push(config.llmApiKey);
    if (config.searchApiKey) secrets.push(config.searchApiKey);
    if (config.upstashRedisRestToken) secrets.push(config.upstashRedisRestToken);
    return secrets;
  } catch {
    // Env invalid/missing (e.g. the run that emits `validation_error`): the
    // pattern pass still protects against `Bearer …`/`sk-…` leakage.
    return [];
  }
}

/** Scrubs known and secret-looking substrings from a single string. */
function redactString(input: string, secrets: readonly string[]): string {
  let out = input;

  // 1. Exact configured secrets — the strongest, false-positive-free signal.
  for (const secret of secrets) {
    if (secret.length >= MIN_EXACT_SECRET_LENGTH && out.includes(secret)) {
      out = out.split(secret).join(REDACTION_PLACEHOLDER);
    }
  }

  // 2. Secret-looking patterns for credentials that are not our configured keys.
  out = out.replace(BEARER_PATTERN, `Bearer ${REDACTION_PLACEHOLDER}`);
  out = out.replace(SK_KEY_PATTERN, REDACTION_PLACEHOLDER);

  return out;
}

/**
 * Deep-walks an arbitrary value, returning a redacted copy. Strings are scrubbed
 * by {@link redactString}; arrays and plain objects are rebuilt with redacted
 * members; every other primitive (number, boolean, null, undefined) is returned
 * unchanged. A `seen` set guards against the pathological cyclic input a
 * `StageEvent.output` of `unknown` type could in principle carry.
 */
function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object)) {
    // Cycle — return as-is rather than recursing forever.
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactValue(member, secrets, seen);
  }
  return result;
}

/**
 * Returns a redacted copy of an arbitrary value. Used by the more specific
 * helpers below; exposed for tests and any future call site that needs to scrub
 * a value whose shape is not known statically.
 */
export function redactSecrets<T>(value: T, secrets: readonly string[] = collectSecretsFromEnv()): T {
  return redactValue(value, secrets, new WeakSet<object>()) as T;
}

/**
 * Returns a redacted copy of a {@link StageEvent}. Every field that can carry
 * free text or opaque output — `message`, `inputSummary`, `output`, `llmCall`,
 * `toolCall`, and the rest — is deep-walked, so a secret is scrubbed regardless
 * of which field or nested shape it landed in. Run this at the emit chokepoint
 * before fan-out (Req 11.6, 14.5).
 */
export function redactStageEvent(
  event: StageEvent,
  secrets: readonly string[] = collectSecretsFromEnv(),
): StageEvent {
  return redactSecrets(event, secrets);
}

/**
 * Returns a redacted copy of a whole {@link RunArtifact}. Run this over the
 * artifact before it is persisted so no secret survives serialization, even if
 * one reached a stage output, ledger entry, or lead field (Req 14.5). Redacting
 * an already-redacted event array is idempotent, so this composes cleanly with
 * the per-event redaction done at emit time.
 */
export function redactArtifact(
  artifact: RunArtifact,
  secrets: readonly string[] = collectSecretsFromEnv(),
): RunArtifact {
  return redactSecrets(artifact, secrets);
}
