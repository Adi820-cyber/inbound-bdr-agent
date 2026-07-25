/**
 * Environment configuration and startup validation (Req 14.1, 14.6).
 *
 * This module is the ONLY config access path in the codebase. No stage,
 * provider, or route reads `process.env` directly — they import `getConfig()`
 * from here. Because this module has no client entry point and is imported only
 * from server files, keeping secret access confined here is what makes Req 14.6
 * (no secret in browser code) structurally true.
 *
 * Validation strategy (from the design's "Startup validation" section):
 *  1. Resolve the selector vars (`LLM_PROVIDER`, `SEARCH_PROVIDER`) FIRST.
 *  2. An unknown selector value fails fast, listing the legal values.
 *  3. Only the key for the SELECTED provider is required — choosing `anthropic`
 *     does not require an OpenAI key, choosing `openrouter` requires only
 *     `OPENROUTER_API_KEY` and nothing from OpenAI/Anthropic/Gemini.
 *  4. Run-store backend selection is implicit: both Upstash vars present → Redis
 *     (durable); otherwise a development-only JSON file store (not durable).
 *
 * Secret values are never logged. Errors name the OFFENDING VARIABLE ONLY,
 * never its value (Req 14.5).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Selector legal values and their key-variable mappings
// ---------------------------------------------------------------------------

export const LLM_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter"] as const;
export const SEARCH_PROVIDERS = ["tavily", "exa", "serper"] as const;

export type LlmProviderName = (typeof LLM_PROVIDERS)[number];
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

/** Which env var supplies the bearer key for each LLM provider. */
const LLM_KEY_VAR: Record<LlmProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Which env var supplies the API key for each search provider. */
const SEARCH_KEY_VAR: Record<SearchProviderName, string> = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  serper: "SERPER_API_KEY",
};

// ---------------------------------------------------------------------------
// Defaults (mirrored in .env.example)
// ---------------------------------------------------------------------------

export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
export const DEFAULT_OPENROUTER_FALLBACK_MODEL = "google/gemma-4-26b-a4b-it:free";
export const DEFAULT_LLM_MAX_RPM = 20;
export const DEFAULT_CRAWL_MAX_PAGES = 12;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Public config shape — the typed object every server module consumes
// ---------------------------------------------------------------------------

export interface EnvConfig {
  /** Selected LLM adapter; also reported name-only in the artifact (Req 14.5). */
  readonly llmProvider: LlmProviderName;
  /** Bearer key for the SELECTED LLM provider only. */
  readonly llmApiKey: string;
  /** Primary OpenRouter model slug (relevant when llmProvider === "openrouter"). */
  readonly openrouterModel: string;
  /** Fallback OpenRouter model slug, tried only on a stage's final attempt. */
  readonly openrouterFallbackModel: string;
  /** Optional HTTP-Referer attribution header value (carries no secret). */
  readonly openrouterAppUrl: string | undefined;
  /** Optional X-Title attribution header value (carries no secret). */
  readonly openrouterAppTitle: string | undefined;
  /** Client-side ceiling on LLM requests per rolling minute, across all adapters. */
  readonly llmMaxRpm: number;

  /** Selected search adapter. */
  readonly searchProvider: SearchProviderName;
  /** API key for the SELECTED search provider only. */
  readonly searchApiKey: string;

  /** Upstash REST URL, present only when durable persistence is configured. */
  readonly upstashRedisRestUrl: string | undefined;
  /** Upstash REST token, present only when durable persistence is configured. */
  readonly upstashRedisRestToken: string | undefined;
  /** Implicitly derived: "upstash" when both Upstash vars present, else "json_file". */
  readonly runStoreBackend: "upstash" | "json_file";
  /** True only for the Upstash backend; the JSON file store does not survive redeploy. */
  readonly runStoreDurable: boolean;

  /** Maximum number of case-study pages crawled per run. */
  readonly crawlMaxPages: number;
  /** Per-request HTTP timeout in milliseconds for search and page fetches. */
  readonly requestTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Error type — fails fast, names the variable only (never its value)
// ---------------------------------------------------------------------------

export class EnvValidationError extends Error {
  /** The offending environment variable name, when a single variable is at fault. */
  readonly variableName: string | undefined;

  constructor(message: string, variableName?: string) {
    super(message);
    this.name = "EnvValidationError";
    this.variableName = variableName;
  }
}

// ---------------------------------------------------------------------------
// Raw env access helper — treats empty / whitespace-only strings as absent
// ---------------------------------------------------------------------------

type RawEnv = Record<string, string | undefined>;

function read(env: RawEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Selector resolution — runs FIRST, fails fast listing legal values
// ---------------------------------------------------------------------------

function resolveSelector<T extends readonly string[]>(
  env: RawEnv,
  name: string,
  legal: T,
): T[number] {
  const value = read(env, name);
  if (value === undefined) {
    throw new EnvValidationError(
      `Missing required environment variable ${name}. Legal values: ${legal.join(", ")}.`,
      name,
    );
  }
  if (!(legal as readonly string[]).includes(value)) {
    throw new EnvValidationError(
      `Invalid value for ${name}: "${value}" is not a legal selector. Legal values: ${legal.join(", ")}.`,
      name,
    );
  }
  return value as T[number];
}

/** Requires a value for the selected provider's key; names the missing variable. */
function requireKey(env: RawEnv, name: string): string {
  const value = read(env, name);
  if (value === undefined) {
    throw new EnvValidationError(
      `Missing required environment variable ${name}.`,
      name,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Zod schema for the non-selector tuning + attribution vars
// ---------------------------------------------------------------------------

/** Coerces an env string to a positive integer, applying a default when absent. */
function positiveIntWithDefault(defaultValue: number) {
  return z.preprocess(
    (raw) => {
      if (raw === undefined || raw === null) return undefined;
      const text = String(raw).trim();
      return text === "" ? undefined : text;
    },
    z.coerce.number().int().positive().default(defaultValue),
  );
}

const tuningSchema = z.object({
  OPENROUTER_MODEL: z.string().min(1).default(DEFAULT_OPENROUTER_MODEL),
  OPENROUTER_FALLBACK_MODEL: z
    .string()
    .min(1)
    .default(DEFAULT_OPENROUTER_FALLBACK_MODEL),
  OPENROUTER_APP_URL: z.string().min(1).optional(),
  OPENROUTER_APP_TITLE: z.string().min(1).optional(),
  LLM_MAX_RPM: positiveIntWithDefault(DEFAULT_LLM_MAX_RPM),
  CRAWL_MAX_PAGES: positiveIntWithDefault(DEFAULT_CRAWL_MAX_PAGES),
  REQUEST_TIMEOUT_MS: positiveIntWithDefault(DEFAULT_REQUEST_TIMEOUT_MS),
});

// ---------------------------------------------------------------------------
// Guard: no secret-bearing variable may use the NEXT_PUBLIC_ prefix (Req 14.6)
// ---------------------------------------------------------------------------

const SECRET_NAME_PATTERN = /(API_KEY|_TOKEN|_SECRET|_KEY)$/;

function assertNoPublicSecretNames(env: RawEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && SECRET_NAME_PATTERN.test(key)) {
      throw new EnvValidationError(
        `Environment variable ${key} uses the NEXT_PUBLIC_ prefix on a secret-bearing name; ` +
          `NEXT_PUBLIC_ values are exposed to browser code and must never carry a secret.`,
        key,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pure parser — the testable core (task 1.8 drives this)
// ---------------------------------------------------------------------------

/**
 * Parses a raw environment into a validated {@link EnvConfig}.
 *
 * Pure with respect to its argument: it reads only from `env` and throws
 * {@link EnvValidationError} on the first problem. Selector vars resolve before
 * any key is required, so only the selected provider's key is demanded.
 */
export function parseEnv(env: RawEnv): EnvConfig {
  assertNoPublicSecretNames(env);

  // 1. Selectors first — unknown value fails fast with the legal-value list.
  const llmProvider = resolveSelector(env, "LLM_PROVIDER", LLM_PROVIDERS);
  const searchProvider = resolveSelector(env, "SEARCH_PROVIDER", SEARCH_PROVIDERS);

  // 2. Only the selected provider's key is required.
  const llmApiKey = requireKey(env, LLM_KEY_VAR[llmProvider]);
  const searchApiKey = requireKey(env, SEARCH_KEY_VAR[searchProvider]);

  // 3. Tuning + attribution vars via Zod (defaults applied here).
  const tuningResult = tuningSchema.safeParse({
    OPENROUTER_MODEL: read(env, "OPENROUTER_MODEL"),
    OPENROUTER_FALLBACK_MODEL: read(env, "OPENROUTER_FALLBACK_MODEL"),
    OPENROUTER_APP_URL: read(env, "OPENROUTER_APP_URL"),
    OPENROUTER_APP_TITLE: read(env, "OPENROUTER_APP_TITLE"),
    LLM_MAX_RPM: read(env, "LLM_MAX_RPM"),
    CRAWL_MAX_PAGES: read(env, "CRAWL_MAX_PAGES"),
    REQUEST_TIMEOUT_MS: read(env, "REQUEST_TIMEOUT_MS"),
  });
  if (!tuningResult.success) {
    const first = tuningResult.error.issues[0];
    const variableName = first?.path[0] ? String(first.path[0]) : undefined;
    const detail = first ? `${variableName ?? "value"}: ${first.message}` : "invalid tuning value";
    throw new EnvValidationError(`Invalid environment configuration (${detail}).`, variableName);
  }
  const tuning = tuningResult.data;

  // 4. Implicit run-store selection: both Upstash vars → durable Redis, else JSON file.
  const upstashRedisRestUrl = read(env, "UPSTASH_REDIS_REST_URL");
  const upstashRedisRestToken = read(env, "UPSTASH_REDIS_REST_TOKEN");
  const hasUpstash = upstashRedisRestUrl !== undefined && upstashRedisRestToken !== undefined;

  return {
    llmProvider,
    llmApiKey,
    openrouterModel: tuning.OPENROUTER_MODEL,
    openrouterFallbackModel: tuning.OPENROUTER_FALLBACK_MODEL,
    openrouterAppUrl: tuning.OPENROUTER_APP_URL,
    openrouterAppTitle: tuning.OPENROUTER_APP_TITLE,
    llmMaxRpm: tuning.LLM_MAX_RPM,

    searchProvider,
    searchApiKey,

    upstashRedisRestUrl,
    upstashRedisRestToken,
    runStoreBackend: hasUpstash ? "upstash" : "json_file",
    runStoreDurable: hasUpstash,

    crawlMaxPages: tuning.CRAWL_MAX_PAGES,
    requestTimeoutMs: tuning.REQUEST_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// Memoized singleton — the only config access path for server modules
// ---------------------------------------------------------------------------

let cached: EnvConfig | undefined;

/**
 * Returns the process-wide {@link EnvConfig}, parsing `process.env` on first
 * call and caching the result. Throws {@link EnvValidationError} on any invalid
 * or missing required variable. This is the single entry point every server
 * module should use to read configuration.
 */
export function getConfig(): EnvConfig {
  if (cached === undefined) {
    cached = parseEnv(process.env as RawEnv);
  }
  return cached;
}

/**
 * Clears the memoized config. Intended for tests that parse alternative
 * environments; not used by production code paths.
 */
export function resetConfigCache(): void {
  cached = undefined;
}
