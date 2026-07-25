/**
 * Anthropic (Claude) LLM adapter (Req 13.5, 14.1, 14.5, 17.4).
 *
 * A selectable `LlmProvider` implementation behind the `LLM_PROVIDER=anthropic`
 * selector. It targets the Messages API (`POST {baseUrl}/v1/messages`) with the
 * `x-api-key` + `anthropic-version` headers. Anthropic has no dedicated
 * JSON-mode flag, so structured output is requested through the system prompt
 * and the shared extractor tolerates a code fence before Zod validation.
 *
 * Like every adapter it routes its transport through the shared throttle via
 * {@link scheduleModelCall} (one RPM chokepoint for all providers), honors
 * `Retry-After` before backoff on a 429, and validates the response against the
 * caller's schema at the boundary, throwing a typed `LlmValidationError`.
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

/** Anthropic requires an explicit `max_tokens`; used when the caller omits one. */
const DEFAULT_MAX_TOKENS = 4_096;
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicConfig extends BaseAdapterConfig {
  name: "anthropic";
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function toMaybeNumber(value: number | undefined): Maybe<number> {
  return typeof value === "number" && Number.isFinite(value) ? value : UNKNOWN;
}

export function createAnthropicProvider(
  config: AnthropicConfig,
  deps: LlmAdapterDeps,
): LlmProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/v1/messages`;

  async function extract(response: Response): Promise<RawCompletion> {
    const body = (await response.json()) as AnthropicResponse;
    const text = body.content?.find((block) => block.type === "text")?.text ?? "";
    return {
      text,
      promptTokens: toMaybeNumber(body.usage?.input_tokens),
      completionTokens: toMaybeNumber(body.usage?.output_tokens),
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
              "x-api-key": config.apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
              ...config.extraHeaders,
            },
            body: JSON.stringify({
              model,
              max_tokens: args.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
              system: args.systemPrompt,
              messages: [{ role: "user", content: args.userPrompt }],
              ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
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
