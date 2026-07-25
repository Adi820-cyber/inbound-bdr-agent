/**
 * LLM provider factory (Req 13.5, 14.1, 14.5, 17.4).
 *
 * Resolves the `LLM_PROVIDER` selector (through the config module only — no
 * adapter reads `process.env`) into a concrete {@link LlmProvider}. The key
 * design point lives here: `openrouter` is a fourth SELECTOR VALUE, not a
 * fourth adapter. Because OpenRouter speaks the OpenAI Chat Completions API,
 * this factory constructs the single OpenAI-compatible adapter twice with
 * different parameters instead of importing a separate `openrouter.ts`:
 *
 *   openai     → https://api.openai.com/v1 (SDK default) + OPENAI_API_KEY + no headers
 *   openrouter → https://openrouter.ai/api/v1 + OPENROUTER_API_KEY + optional
 *                HTTP-Referer / X-Title attribution headers
 *
 * The adapter's `name` is the selector value, so an OpenRouter-configured run
 * reports `"openrouter"` in `providerConfig.llmProvider` (Req 14.5).
 *
 * The fallback model is only meaningful for OpenRouter (that is where a free
 * primary model and its secondary live); the other selectors report `"unknown"`
 * for `fallbackModel`, which makes the orchestrator's `useFallbackModel` flag a
 * no-op for them — the primary model always serves.
 */

import type { EnvConfig } from "../../lib/config/env";
import { getConfig } from "../../lib/config/env";
import type { LlmProvider } from "../../agent/contracts";
import { UNKNOWN } from "../../agent/contracts";

import { createOpenAiCompatibleProvider } from "./openai";
import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import type { LlmAdapterDeps } from "./shared";

// Re-export the typed boundary error and shared types so callers import them
// from the provider package rather than reaching into an internal module.
export { LlmValidationError } from "./shared";
export type {
  LlmAdapterDeps,
  LlmCallEmitter,
  LlmCallTrace,
  LlmValidationErrorKind,
} from "./shared";
export { parseRetryAfter, backoffDelayMs } from "./shared";

// ---------------------------------------------------------------------------
// Base URLs and default models for the non-OpenRouter selectors
// ---------------------------------------------------------------------------

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Default model slugs for the selectors that have no dedicated model env var.
 * OpenRouter is intentionally absent: its primary and fallback slugs come from
 * `OPENROUTER_MODEL` / `OPENROUTER_FALLBACK_MODEL` in the config module.
 */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";

// ---------------------------------------------------------------------------
// OpenRouter attribution headers (carry no secret; absence changes nothing)
// ---------------------------------------------------------------------------

/**
 * Builds the optional OpenRouter attribution headers. `HTTP-Referer` and
 * `X-Title` credit the calling app on OpenRouter's public leaderboards; both
 * are optional and secret-free. Returns `undefined` when neither is configured
 * so no empty header object is attached.
 */
function buildOpenRouterHeaders(config: EnvConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (config.openrouterAppUrl !== undefined) {
    headers["HTTP-Referer"] = config.openrouterAppUrl;
  }
  if (config.openrouterAppTitle !== undefined) {
    headers["X-Title"] = config.openrouterAppTitle;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Constructs the {@link LlmProvider} selected by `LLM_PROVIDER`.
 *
 * @param deps   shared throttle, optional `llm_call` emitter, and injectable
 *               clock/fetch for testing.
 * @param config resolved environment configuration; defaults to the process
 *               singleton but is injectable so task 2.10 can assert the
 *               OpenRouter parameterization without touching `process.env`.
 */
export function createLlmProvider(
  deps: LlmAdapterDeps,
  config: EnvConfig = getConfig(),
): LlmProvider {
  switch (config.llmProvider) {
    case "openai":
      return createOpenAiCompatibleProvider(
        {
          name: "openai",
          baseUrl: OPENAI_BASE_URL,
          apiKey: config.llmApiKey,
          model: DEFAULT_OPENAI_MODEL,
          fallbackModel: UNKNOWN,
        },
        deps,
      );

    case "openrouter":
      return createOpenAiCompatibleProvider(
        {
          name: "openrouter",
          baseUrl: OPENROUTER_BASE_URL,
          apiKey: config.llmApiKey,
          model: config.openrouterModel,
          fallbackModel: config.openrouterFallbackModel,
          extraHeaders: buildOpenRouterHeaders(config),
        },
        deps,
      );

    case "anthropic":
      return createAnthropicProvider(
        {
          name: "anthropic",
          baseUrl: ANTHROPIC_BASE_URL,
          apiKey: config.llmApiKey,
          model: DEFAULT_ANTHROPIC_MODEL,
          fallbackModel: UNKNOWN,
        },
        deps,
      );

    case "gemini":
      return createGeminiProvider(
        {
          name: "gemini",
          baseUrl: GEMINI_BASE_URL,
          apiKey: config.llmApiKey,
          model: DEFAULT_GEMINI_MODEL,
          fallbackModel: UNKNOWN,
        },
        deps,
      );
  }
}

export { createOpenAiCompatibleProvider } from "./openai";
export { createAnthropicProvider } from "./anthropic";
export { createGeminiProvider } from "./gemini";
