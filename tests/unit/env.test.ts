/**
 * Unit tests for env parsing and `.env.example` parity (Task 1.8, Req 14.1, 14.3).
 *
 * These tests drive the pure `parseEnv(customEnvObject)` core — they never read
 * or mutate `process.env`. Two guarantees are locked down here:
 *
 *   1. Parity (Req 14.3): the set of keys documented in `.env.example` is
 *      EXACTLY the set of variables the env parser recognizes. A drift in
 *      either direction (an undocumented recognized var, or a documented var
 *      the parser ignores) fails the suite, so the template stays honest.
 *
 *   2. Fail-fast selectors (Req 14.1): an unknown `LLM_PROVIDER` /
 *      `SEARCH_PROVIDER` value throws `EnvValidationError` whose message lists
 *      the legal values, selectors resolve before keys are required, and only
 *      the SELECTED provider's key is demanded.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EnvValidationError,
  LLM_PROVIDERS,
  SEARCH_PROVIDERS,
  parseEnv,
} from "@/lib/config/env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_EXAMPLE_PATH = resolve(PROJECT_ROOT, ".env.example");

/** The bearer/API key variable name each provider selector maps to. */
function providerKeyVar(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

/**
 * The full set of environment variables the parser recognizes, derived where
 * possible from the exported selector legal-value lists so that adding a
 * provider is picked up automatically. The non-provider tuning / attribution /
 * store variables are listed explicitly.
 */
function recognizedEnvKeys(): Set<string> {
  return new Set<string>([
    // Selectors
    "LLM_PROVIDER",
    "SEARCH_PROVIDER",
    // One key per LLM / search provider (derived from the exported lists)
    ...LLM_PROVIDERS.map(providerKeyVar),
    ...SEARCH_PROVIDERS.map(providerKeyVar),
    // OpenRouter tuning + attribution
    "OPENROUTER_MODEL",
    "OPENROUTER_FALLBACK_MODEL",
    "OPENROUTER_APP_URL",
    "OPENROUTER_APP_TITLE",
    "LLM_MAX_RPM",
    // Run store (Upstash)
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    // Retrieval tuning
    "CRAWL_MAX_PAGES",
    "REQUEST_TIMEOUT_MS",
    // Optional inbound-webhook auth + AE handoff delivery
    "AE_HANDOFF_WEBHOOK_URL",
    "INBOUND_WEBHOOK_SECRET",
  ]);
}

/** Parses `.env.example`, returning the set of documented variable names. */
function envExampleKeys(): Set<string> {
  const contents = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  const keys = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

/** A minimal env that parses successfully; override fields per test. */
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LLM_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    SEARCH_PROVIDER: "tavily",
    TAVILY_API_KEY: "tvly-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. `.env.example` parity (Req 14.3)
// ---------------------------------------------------------------------------

describe(".env.example parity", () => {
  it("documents exactly the variables the env parser recognizes", () => {
    const documented = envExampleKeys();
    const recognized = recognizedEnvKeys();

    const undocumented = [...recognized].filter((k) => !documented.has(k)).sort();
    const unrecognized = [...documented].filter((k) => !recognized.has(k)).sort();

    expect(undocumented, "recognized vars missing from .env.example").toEqual([]);
    expect(unrecognized, ".env.example vars the parser does not recognize").toEqual([]);
    expect(documented).toEqual(recognized);
  });

  it("documents a key variable for every legal LLM and search provider", () => {
    const documented = envExampleKeys();
    for (const provider of LLM_PROVIDERS) {
      expect(documented, `LLM key var for ${provider}`).toContain(providerKeyVar(provider));
    }
    for (const provider of SEARCH_PROVIDERS) {
      expect(documented, `search key var for ${provider}`).toContain(providerKeyVar(provider));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Unknown selector fails fast, listing legal values (Req 14.1)
// ---------------------------------------------------------------------------

describe("selector validation", () => {
  it("throws EnvValidationError listing the legal LLM_PROVIDER values", () => {
    const env = baseEnv({ LLM_PROVIDER: "not-a-provider" });
    expect(() => parseEnv(env)).toThrow(EnvValidationError);

    try {
      parseEnv(env);
      expect.fail("expected parseEnv to throw for an invalid LLM_PROVIDER");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;
      expect(err.variableName).toBe("LLM_PROVIDER");
      expect(err.message).toContain("LLM_PROVIDER");
      // The message lists every legal value.
      for (const legal of LLM_PROVIDERS) {
        expect(err.message).toContain(legal);
      }
      // The offending value is not silently accepted.
      expect(err.message).toContain("not-a-provider");
    }
  });

  it("throws EnvValidationError listing the legal SEARCH_PROVIDER values", () => {
    const env = baseEnv({ SEARCH_PROVIDER: "bing" });

    try {
      parseEnv(env);
      expect.fail("expected parseEnv to throw for an invalid SEARCH_PROVIDER");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;
      expect(err.variableName).toBe("SEARCH_PROVIDER");
      expect(err.message).toContain("SEARCH_PROVIDER");
      for (const legal of SEARCH_PROVIDERS) {
        expect(err.message).toContain(legal);
      }
    }
  });

  it("fails fast with the legal-value list when a selector is missing", () => {
    const env = baseEnv({ LLM_PROVIDER: undefined });

    try {
      parseEnv(env);
      expect.fail("expected parseEnv to throw for a missing LLM_PROVIDER");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;
      expect(err.variableName).toBe("LLM_PROVIDER");
      for (const legal of LLM_PROVIDERS) {
        expect(err.message).toContain(legal);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Only the selected provider's key is required (Req 14.1)
// ---------------------------------------------------------------------------

describe("selected-provider key requirement", () => {
  it("requires only the selected LLM provider's key (anthropic needs no OpenAI key)", () => {
    const env = {
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      // Deliberately no OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY.
      SEARCH_PROVIDER: "tavily",
      TAVILY_API_KEY: "tvly-test",
    };

    const config = parseEnv(env);
    expect(config.llmProvider).toBe("anthropic");
    expect(config.llmApiKey).toBe("sk-ant-test");
  });

  it("requires only OPENROUTER_API_KEY when LLM_PROVIDER=openrouter", () => {
    const env = {
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      SEARCH_PROVIDER: "exa",
      EXA_API_KEY: "exa-test",
    };

    const config = parseEnv(env);
    expect(config.llmProvider).toBe("openrouter");
    expect(config.llmApiKey).toBe("sk-or-test");
    expect(config.searchProvider).toBe("exa");
    expect(config.searchApiKey).toBe("exa-test");
  });

  it("throws naming the missing key for the selected provider only", () => {
    // Selects openai but supplies no OPENAI_API_KEY.
    const env = {
      LLM_PROVIDER: "openai",
      SEARCH_PROVIDER: "tavily",
      TAVILY_API_KEY: "tvly-test",
    };

    try {
      parseEnv(env);
      expect.fail("expected parseEnv to throw for the missing selected-provider key");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;
      expect(err.variableName).toBe("OPENAI_API_KEY");
      expect(err.message).toContain("OPENAI_API_KEY");
    }
  });

  it("applies defaults and derives the JSON-file store when Upstash vars are absent", () => {
    const config = parseEnv(baseEnv());
    expect(config.runStoreBackend).toBe("json_file");
    expect(config.runStoreDurable).toBe(false);
    expect(config.crawlMaxPages).toBe(12);
    expect(config.requestTimeoutMs).toBe(15000);
    expect(config.llmMaxRpm).toBe(20);
  });
});
