/**
 * Google Gemini LLM adapter (Req 13.5, 14.1, 14.5, 17.4).
 *
 * A selectable `LlmProvider` implementation behind the `LLM_PROVIDER=gemini`
 * selector. It targets the Generative Language API
 * (`POST {baseUrl}/models/{model}:generateContent?key=...`) and asks for JSON
 * via `generationConfig.responseMimeType`. The API key travels as a query
 * parameter per the REST contract; it is never logged (Req 14.5).
 *
 * As with the other adapters, all transport is routed through the shared
 * throttle via {@link scheduleModelCall} (single RPM chokepoint), a 429 honors
 * `Retry-After` before exponential backoff, and the model output is validated
 * against the caller's Zod schema at the boundary, throwing a typed
 * `LlmValidationError` on any failure.
 */

import type { ZodType } from "zod";

import type { LlmProvider, Maybe } from "../../agent/contracts";
import { UNKNOWN } from "../../agent/contracts";
import type { BaseAdapterConfig, LlmAdapterDeps, RawCompletion } from "./shared";
import {
  parseAndValidate,
  resolveServingModel,
  scheduleModelCall,
} from "./shared";

export interface GeminiConfig extends BaseAdapterConfig {
  name: "gemini";
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

function toMaybeNumber(value: number | undefined): Maybe<number> {
  return typeof value === "number" && Number.isFinite(value) ? value : UNKNOWN;
}

export function createGeminiProvider(
  config: GeminiConfig,
  deps: LlmAdapterDeps,
): LlmProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/$/, "");

  async function extract(response: Response): Promise<RawCompletion> {
    const body = (await response.json()) as GeminiResponse;
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? "").join("");
    return {
      text,
      promptTokens: toMaybeNumber(body.usageMetadata?.promptTokenCount),
      completionTokens: toMaybeNumber(body.usageMetadata?.candidatesTokenCount),
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
      // Key travels as a query param per the REST contract (never logged).
      const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

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
              ...config.extraHeaders,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: args.systemPrompt }] },
              contents: [{ role: "user", parts: [{ text: args.userPrompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
                ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
                ...(args.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: args.maxOutputTokens }),
              },
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
