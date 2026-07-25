/**
 * OpenAI-compatible LLM adapter (Req 13.5, 14.1, 14.5, 17.4).
 *
 * This is the ONLY adapter used for two selector values. OpenRouter speaks the
 * OpenAI Chat Completions API verbatim, so a separate `openrouter.ts` would
 * duplicate this file for no reason. Instead the factory in `index.ts`
 * constructs this adapter twice, parameterized by `{ baseUrl, apiKey, model,
 * extraHeaders }`:
 *   - `openai`     → https://api.openai.com/v1, OPENAI_API_KEY, no extra headers
 *   - `openrouter` → https://openrouter.ai/api/v1, OPENROUTER_API_KEY, plus the
 *                    optional HTTP-Referer / X-Title attribution headers
 *
 * Because `name` is the selector value, an OpenRouter-configured run reports
 * `"openrouter"` in `providerConfig.llmProvider`, not `"openai"` (Req 14.5).
 *
 * Every outbound transport call is wrapped in `throttle.schedule(...)` via the
 * shared {@link scheduleModelCall} so the per-minute ceiling is enforced at one
 * chokepoint for all providers, and the returned value is validated against the
 * caller's Zod schema at the boundary before it is handed back.
 */

import type { ZodType } from "zod";

import type { LlmProvider, Maybe } from "../../agent/contracts";
import { UNKNOWN } from "../../agent/contracts";
import type {
  LlmAdapterDeps,
  RawCompletion,
} from "./shared";
import type { OpenAiCompatibleConfig } from "../../agent/contracts";
import {
  parseAndValidate,
  resolveServingModel,
  scheduleModelCall,
} from "./shared";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function toMaybeNumber(value: number | undefined): Maybe<number> {
  return typeof value === "number" && Number.isFinite(value) ? value : UNKNOWN;
}

/**
 * Creates an OpenAI-compatible `LlmProvider`. Shared by the `openai` and
 * `openrouter` selector values; the only differences are the injected
 * `baseUrl`, `apiKey`, and attribution `extraHeaders`.
 */
export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleConfig,
  deps: LlmAdapterDeps,
): LlmProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  async function extract(response: Response): Promise<RawCompletion> {
    const body = (await response.json()) as ChatCompletionResponse;
    const text = body.choices?.[0]?.message?.content ?? "";
    return {
      text,
      promptTokens: toMaybeNumber(body.usage?.prompt_tokens),
      completionTokens: toMaybeNumber(body.usage?.completion_tokens),
    };
  }

  return {
    name: config.name,
    model: config.model,
    fallbackModel: config.fallbackModel,

    async completeJson<T>(args: {
      purpose: string;
      systemPrompt: string;
      userPrompt: string;
      schema: ZodType<T>;
      maxOutputTokens?: number;
      temperature?: number;
      useFallbackModel?: boolean;
    }) {
      const { model, fallbackModelUsed } = resolveServingModel(
        config.model,
        config.fallbackModel,
        args.useFallbackModel,
      );

      const completion = await scheduleModelCall({
        deps,
        provider: config.name,
        model,
        purpose: args.purpose,
        fallbackModelUsed,
        performRequest: () =>
          fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
              ...config.extraHeaders,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: args.systemPrompt },
                { role: "user", content: args.userPrompt },
              ],
              response_format: { type: "json_object" },
              ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
              ...(args.maxOutputTokens === undefined
                ? {}
                : { max_tokens: args.maxOutputTokens }),
            }),
          }),
        extract,
      });

      const value = parseAndValidate(completion.text, args.schema, config.name, model);
      return {
        value,
        modelUsed: model,
        usage: {
          promptTokens: completion.promptTokens,
          completionTokens: completion.completionTokens,
        },
      };
    },
  };
}
