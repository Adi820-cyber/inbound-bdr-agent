/**
 * Shared test doubles for the agent's provider boundaries (Task 1.5,
 * Req 13.4, 17.4).
 *
 * Every property, unit, and component test obtains its LLM through
 * `createStubLlmProvider(...)` and its network transports through the stubs
 * here. No test constructs a real adapter, so the design's Mocking Boundaries
 * rule holds structurally:
 *
 *  - `createStubLlmProvider` implements the full `LlmProvider` interface and
 *    returns caller-supplied or schema-valid generated values, never touching a
 *    live model.
 *  - `createStubSearchProvider` implements `SearchProvider` with caller-supplied
 *    or scripted hits.
 *  - `createStubPageFetchTransport` stubs ONLY the page-fetch transport, so
 *    toolbelt/provenance tests exercise the REAL toolbelt and the REAL fetch
 *    ledger with just the network hop replaced (design: "ResearchToolbelt is
 *    used real in provenance tests, with only its transport stubbed").
 */

import type { ZodType } from "zod";
import type {
  FetchedPage,
  LlmProvider,
  Maybe,
  SearchHit,
  SearchProvider,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";

// ---------------------------------------------------------------------------
// Schema-valid value generation
// ---------------------------------------------------------------------------

/**
 * Produces a minimal, deterministic value that satisfies `schema`. Used as the
 * fallback for `completeJson` when a test does not script a response. The
 * result is parsed against the schema by the caller, so any gap here fails
 * loudly rather than returning an invalid shape.
 *
 * Walks the Zod v4 `def` tree covering the type set used by the agent's
 * contract schemas: object, string, number, boolean, array, tuple, union,
 * enum, literal, record, optional, nullable, null, and default.
 */
export function generateSchemaValidValue(schema: ZodType): unknown {
  const def = (schema as unknown as { def: ZodDef }).def;
  switch (def.type) {
    case "string":
      return generateString(def);
    case "number":
      return generateNumber(def);
    case "boolean":
      return false;
    case "literal":
      return def.values?.[0];
    case "enum": {
      const values = Object.values(def.entries ?? {});
      return values[0];
    }
    case "null":
      return null;
    case "optional":
    case "nullable":
    case "default":
      return def.innerType ? generateSchemaValidValue(def.innerType) : undefined;
    case "array":
      return generateArray(def);
    case "tuple":
      return (def.items ?? []).map((item) => generateSchemaValidValue(item));
    case "object":
      return generateObject(def);
    case "union":
      // Prefer the first non-literal option; fall back to the first option.
      return generateSchemaValidValue((def.options ?? [])[0]!);
    case "record":
      return {};
    default:
      // Unknown/unsupported node: an empty object is the least-surprising stub.
      return undefined;
  }
}

interface ZodCheckDef {
  check?: string;
  minimum?: number;
  maximum?: number;
  value?: number;
  inclusive?: boolean;
}

interface ZodDef {
  type: string;
  values?: unknown[];
  entries?: Record<string, unknown>;
  innerType?: ZodType;
  element?: ZodType;
  items?: ZodType[];
  options?: ZodType[];
  shape?: Record<string, ZodType>;
  checks?: { _zod?: { def?: ZodCheckDef } }[];
}

function readChecks(def: ZodDef): ZodCheckDef[] {
  return (def.checks ?? []).map((c) => c._zod?.def ?? {});
}

function generateString(def: ZodDef): string {
  let min = 0;
  for (const c of readChecks(def)) {
    if (c.check === "min_length" && typeof c.minimum === "number") min = c.minimum;
  }
  const base = "stub";
  return base.length >= min ? base : base.padEnd(min, "x");
}

function generateNumber(def: ZodDef): number {
  let min: number | undefined;
  let max: number | undefined;
  let isInt = false;
  for (const c of readChecks(def)) {
    if (c.check === "number_format") isInt = true;
    if (c.check === "greater_than" && typeof c.value === "number") {
      min = c.inclusive ? c.value : c.value + (isInt ? 1 : Number.EPSILON);
    }
    if (c.check === "less_than" && typeof c.value === "number") {
      max = c.inclusive ? c.value : c.value - (isInt ? 1 : Number.EPSILON);
    }
  }
  let value = min ?? 0;
  if (max !== undefined && value > max) value = max;
  return isInt ? Math.round(value) : value;
}

function generateArray(def: ZodDef): unknown[] {
  let min = 0;
  for (const c of readChecks(def)) {
    if (c.check === "min_length" && typeof c.minimum === "number") min = c.minimum;
  }
  const element = def.element;
  const out: unknown[] = [];
  for (let i = 0; i < min; i++) {
    out.push(element ? generateSchemaValidValue(element) : undefined);
  }
  return out;
}

function generateObject(def: ZodDef): Record<string, unknown> {
  const shape = def.shape ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    const childDef = (child as unknown as { def: ZodDef }).def;
    // Skip optional keys to keep the generated object minimal.
    if (childDef.type === "optional") continue;
    out[key] = generateSchemaValidValue(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stub LlmProvider
// ---------------------------------------------------------------------------

type CompleteJsonArgs<T> = Parameters<LlmProvider["completeJson"]>[0] & {
  schema: ZodType<T>;
};

/**
 * A response script for `completeJson`. May be:
 *  - a single value (returned for every call),
 *  - an array used as a FIFO queue (one value per call), or
 *  - a function of the call args returning either a bare value or a value
 *    together with `modelUsed` / `usage` overrides.
 */
export type StubLlmResponder<T = unknown> =
  | T
  | T[]
  | ((args: CompleteJsonArgs<T>) =>
      | T
      | { value: T; modelUsed?: string; usage?: LlmUsage }
      | Promise<T | { value: T; modelUsed?: string; usage?: LlmUsage }>);

type LlmUsage = { promptTokens: Maybe<number>; completionTokens: Maybe<number> };

export interface StubLlmOptions {
  name?: LlmProvider["name"];
  model?: string;
  fallbackModel?: Maybe<string>;
  /** Default token usage reported by every call unless a responder overrides it. */
  usage?: LlmUsage;
  /**
   * Response script. When omitted, each call returns a schema-valid value
   * generated from the `schema` passed to that call.
   */
  respondWith?: StubLlmResponder;
  /** Called with each set of `completeJson` args, for assertions in tests. */
  onCall?: (args: CompleteJsonArgs<unknown>) => void;
}

/** A stub `LlmProvider` that never contacts a live model. */
export interface StubLlmProvider extends LlmProvider {
  /** All `completeJson` arg sets captured, in call order, for assertions. */
  readonly calls: ReadonlyArray<CompleteJsonArgs<unknown>>;
}

/**
 * Creates a stub `LlmProvider` implementing the full interface. Returns
 * caller-supplied or schema-valid generated values plus `modelUsed` and
 * `usage`. This is the single LLM entry point for property, unit, and
 * component tests.
 */
export function createStubLlmProvider(options: StubLlmOptions = {}): StubLlmProvider {
  const name = options.name ?? "openrouter";
  const model = options.model ?? "stub-model";
  const fallbackModel = options.fallbackModel ?? UNKNOWN;
  const defaultUsage: LlmUsage = options.usage ?? {
    promptTokens: 0,
    completionTokens: 0,
  };

  const calls: CompleteJsonArgs<unknown>[] = [];
  // Mutable copy of an array responder so successive calls dequeue from it.
  const queue = Array.isArray(options.respondWith)
    ? [...(options.respondWith as unknown[])]
    : null;

  async function resolveResponse<T>(
    args: CompleteJsonArgs<T>,
  ): Promise<{ value: T; modelUsed?: string; usage?: LlmUsage }> {
    const responder = options.respondWith;

    if (responder === undefined) {
      return { value: generateSchemaValidValue(args.schema) as T };
    }
    if (queue) {
      const next = queue.length > 0 ? queue.shift() : undefined;
      return { value: next as T };
    }
    if (typeof responder === "function") {
      const fn = responder as (a: CompleteJsonArgs<T>) => unknown;
      const result = await fn(args);
      if (result !== null && typeof result === "object" && "value" in result) {
        return result as { value: T; modelUsed?: string; usage?: LlmUsage };
      }
      return { value: result as T };
    }
    return { value: responder as T };
  }

  const provider: StubLlmProvider = {
    name,
    model,
    fallbackModel,
    calls,
    async completeJson<T>(args: CompleteJsonArgs<T>) {
      calls.push(args as CompleteJsonArgs<unknown>);
      options.onCall?.(args as CompleteJsonArgs<unknown>);

      const { value, modelUsed, usage } = await resolveResponse(args);
      // Guarantee schema-validity of whatever we hand back (Req 17.4 boundary):
      // a scripted value that violates the schema fails here, loudly.
      const parsed = args.schema.parse(value);

      const usedFallback = args.useFallbackModel === true && fallbackModel !== UNKNOWN;
      return {
        value: parsed,
        modelUsed:
          modelUsed ?? (usedFallback ? (fallbackModel as string) : model),
        usage: usage ?? defaultUsage,
      };
    },
  };

  return provider;
}

// ---------------------------------------------------------------------------
// Stub SearchProvider
// ---------------------------------------------------------------------------

export type StubSearchResponder =
  | SearchHit[]
  | ((query: string, opts?: { maxResults?: number; site?: string }) =>
      | SearchHit[]
      | Promise<SearchHit[]>);

export interface StubSearchOptions {
  name?: SearchProvider["name"];
  /** Hits to return. When omitted, every search returns `[]`. */
  respondWith?: StubSearchResponder;
  onCall?: (query: string, opts?: { maxResults?: number; site?: string }) => void;
}

export interface StubSearchProvider extends SearchProvider {
  readonly calls: ReadonlyArray<{
    query: string;
    opts?: { maxResults?: number; site?: string };
  }>;
}

/** Creates a stub `SearchProvider` that never contacts a live search API. */
export function createStubSearchProvider(
  options: StubSearchOptions = {},
): StubSearchProvider {
  const calls: { query: string; opts?: { maxResults?: number; site?: string } }[] = [];
  const provider: StubSearchProvider = {
    name: options.name ?? "tavily",
    calls,
    async search(query, opts) {
      calls.push({ query, opts });
      options.onCall?.(query, opts);
      const responder = options.respondWith;
      if (responder === undefined) return [];
      const hits =
        typeof responder === "function" ? await responder(query, opts) : responder;
      const limit = opts?.maxResults;
      return typeof limit === "number" ? hits.slice(0, limit) : hits;
    },
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Stub page-fetch transport
// ---------------------------------------------------------------------------

/**
 * The single network hop the REAL toolbelt performs to fetch a page. Tests stub
 * ONLY this function, so the production toolbelt and its fetch ledger run
 * unchanged around it. A `null` return models a failed/aborted fetch.
 */
export type PageFetchTransport = (url: string) => Promise<FetchedPage | null>;

export type StubPageFetchResponder =
  | Record<string, FetchedPage | null>
  | ((url: string) => FetchedPage | null | Promise<FetchedPage | null>);

export interface StubPageFetchOptions {
  /**
   * Responses keyed by URL, or a function of the URL. When a URL is not mapped
   * (or no responder is given), the transport resolves to `null`, modelling a
   * fetch that produced no usable page.
   */
  respondWith?: StubPageFetchResponder;
  onCall?: (url: string) => void;
}

export interface StubPageFetchTransport {
  readonly transport: PageFetchTransport;
  readonly calls: ReadonlyArray<string>;
}

/** Builds a well-formed `FetchedPage` for tests, overridable field by field. */
export function makeFetchedPage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  const requestedUrl = overrides.requestedUrl ?? "https://example.com/page";
  return {
    requestedUrl,
    finalUrl: overrides.finalUrl ?? requestedUrl,
    statusCode: overrides.statusCode ?? 200,
    text: overrides.text ?? "stub page text",
    retrievedAt: overrides.retrievedAt ?? "2024-01-01T00:00:00.000Z",
    fromCache: overrides.fromCache ?? false,
  };
}

/**
 * Creates a stub page-fetch transport. Pass its `.transport` to the real
 * toolbelt so provenance tests run against the production ledger with only the
 * network replaced.
 */
export function createStubPageFetchTransport(
  options: StubPageFetchOptions = {},
): StubPageFetchTransport {
  const calls: string[] = [];
  const transport: PageFetchTransport = async (url) => {
    calls.push(url);
    options.onCall?.(url);
    const responder = options.respondWith;
    if (responder === undefined) return null;
    if (typeof responder === "function") return responder(url);
    return responder[url] ?? null;
  };
  return { transport, calls };
}
