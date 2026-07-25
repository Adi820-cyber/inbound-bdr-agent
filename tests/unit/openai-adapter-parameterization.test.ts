/**
 * Unit tests for the OpenAI-compatible adapter's OpenRouter parameterization
 * (Task 2.10, Req 14.1, 14.5).
 *
 * OpenRouter is a fourth SELECTOR VALUE, not a fourth adapter: the factory in
 * `src/providers/llm/index.ts` constructs the single OpenAI-compatible adapter
 * with OpenRouter's base URL, key, and attribution headers. These tests assert
 * that wiring end-to-end WITHOUT any live network call: the transport is stubbed
 * through the injectable `deps.fetchImpl` seam, and the config is injected
 * through the `createLlmProvider(deps, config)` seam so `process.env` is never
 * touched. What we verify:
 *
 *   - the adapter's `name` reports "openrouter" (Req 14.5),
 *   - the base URL is https://openrouter.ai/api/v1 (…/chat/completions endpoint),
 *   - the Authorization bearer carries the OpenRouter key (and no OpenAI key is
 *     required — the config exposes only the SELECTED provider's key),
 *   - both attribution headers (HTTP-Referer / X-Title) are set from
 *     OPENROUTER_APP_URL / OPENROUTER_APP_TITLE.
 *
 * A contrast case with LLM_PROVIDER=openai confirms the same adapter yields the
 * OpenAI base URL and NO attribution headers, proving the difference is pure
 * parameterization.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createLlmProvider } from "@/providers/llm";
import type { LlmAdapterDeps } from "@/providers/llm";
import type { EnvConfig } from "@/lib/config/env";
import type { LlmThrottle } from "@/agent/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = "sk-or-test-key";
const OPENAI_KEY = "sk-openai-test-key";

/** A pass-through throttle: runs the scheduled call immediately, in order. */
const passthroughThrottle: LlmThrottle = {
  schedule: <T>(_purpose: string, fn: () => Promise<T>): Promise<T> => fn(),
};

/** One captured outbound request from the stubbed transport. */
interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Builds an injected transport that records every request and replies with a
 * schema-valid Chat Completions body. Nothing touches the network — the guard
 * in tests/setup/no-live-calls.ts still stands untouched because we never call
 * the global `fetch`.
 */
function makeStubTransport(): { fetchImpl: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({ url, headers, body });

    const responseBody = {
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, captured };
}

/**
 * A complete {@link EnvConfig}. `createLlmProvider` reads only the LLM-relevant
 * fields, but the full shape is supplied so the injected config is type-exact.
 * Note there is NO separate OpenAI key field: `llmApiKey` holds the SELECTED
 * provider's key only, which is precisely why choosing `openrouter` requires no
 * OpenAI key.
 */
function makeConfig(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    llmProvider: "openrouter",
    llmApiKey: OPENROUTER_KEY,
    openrouterModel: "google/gemma-4-31b-it:free",
    openrouterFallbackModel: "google/gemma-4-26b-a4b-it:free",
    openrouterAppUrl: "https://app.example.com",
    openrouterAppTitle: "Inbound BDR Agent",
    llmMaxRpm: 20,
    searchProvider: "tavily",
    searchApiKey: "tvly-test",
    upstashRedisRestUrl: undefined,
    upstashRedisRestToken: undefined,
    runStoreBackend: "json_file",
    runStoreDurable: false,
    crawlMaxPages: 12,
    requestTimeoutMs: 15000,
    aeHandoffWebhookUrl: undefined,
    inboundWebhookSecret: undefined,
    ...overrides,
  };
}

/** A trivial schema for the round-trip; the stub returns `{ ok: true }`. */
const okSchema = z.object({ ok: z.boolean() });

async function invokeOnce(
  config: EnvConfig,
): Promise<{ name: string; request: CapturedRequest }> {
  const { fetchImpl, captured } = makeStubTransport();
  const deps: LlmAdapterDeps = { throttle: passthroughThrottle, fetchImpl };

  const provider = createLlmProvider(deps, config);
  await provider.completeJson({
    purpose: "unit-test",
    systemPrompt: "sys",
    userPrompt: "usr",
    schema: okSchema,
  });

  expect(captured).toHaveLength(1);
  return { name: provider.name, request: captured[0]! };
}

// ---------------------------------------------------------------------------
// openrouter parameterization (Req 14.1, 14.5)
// ---------------------------------------------------------------------------

describe("OpenAI-compatible adapter — openrouter parameterization", () => {
  it("reports the adapter name as \"openrouter\" (Req 14.5)", () => {
    const deps: LlmAdapterDeps = { throttle: passthroughThrottle, fetchImpl: makeStubTransport().fetchImpl };
    const provider = createLlmProvider(deps, makeConfig());
    expect(provider.name).toBe("openrouter");
  });

  it("targets the OpenRouter base URL", async () => {
    const { request } = await invokeOnce(makeConfig());
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("uses the OpenRouter key as the Authorization bearer, requiring no OpenAI key", async () => {
    // The injected config carries only the selected provider's key. There is no
    // OpenAI key anywhere in the config, yet construction and the call succeed.
    const { request } = await invokeOnce(makeConfig());
    expect(request.headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
  });

  it("sets both attribution headers from OPENROUTER_APP_URL / OPENROUTER_APP_TITLE", async () => {
    const { request } = await invokeOnce(
      makeConfig({
        openrouterAppUrl: "https://app.example.com",
        openrouterAppTitle: "Inbound BDR Agent",
      }),
    );
    expect(request.headers["HTTP-Referer"]).toBe("https://app.example.com");
    expect(request.headers["X-Title"]).toBe("Inbound BDR Agent");
  });

  it("serves the configured OpenRouter primary model", async () => {
    const { request } = await invokeOnce(makeConfig({ openrouterModel: "openrouter/free-model" }));
    expect((request.body as { model: string }).model).toBe("openrouter/free-model");
  });

  it("omits attribution headers when neither app var is configured", async () => {
    const { request } = await invokeOnce(
      makeConfig({ openrouterAppUrl: undefined, openrouterAppTitle: undefined }),
    );
    expect(request.headers["HTTP-Referer"]).toBeUndefined();
    expect(request.headers["X-Title"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Contrast: the same adapter under the openai selector (Req 14.1)
// ---------------------------------------------------------------------------

describe("OpenAI-compatible adapter — openai parameterization contrast", () => {
  it("uses the OpenAI base URL, the OpenAI key, and no attribution headers", async () => {
    const { name, request } = await invokeOnce(
      makeConfig({ llmProvider: "openai", llmApiKey: OPENAI_KEY }),
    );
    expect(name).toBe("openai");
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(request.headers["HTTP-Referer"]).toBeUndefined();
    expect(request.headers["X-Title"]).toBeUndefined();
  });
});
