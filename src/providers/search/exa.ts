/**
 * Exa search adapter (Req 13.5).
 *
 * Implements {@link SearchProvider} against Exa's `/search` endpoint. The API key
 * and per-request timeout come exclusively from `getConfig()` — this module never
 * reads `process.env` directly (Req 14.6). Mapping to {@link SearchHit} is total:
 * any field Exa omits becomes the literal `"unknown"`.
 */

import { UNKNOWN, type Maybe, type SearchHit, type SearchProvider } from "@/agent/contracts";
import { getConfig } from "@/lib/config/env";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const DEFAULT_MAX_RESULTS = 5;

interface ExaResult {
  url?: unknown;
  title?: unknown;
  text?: unknown;
  snippet?: unknown;
  publishedDate?: unknown;
}

interface ExaResponse {
  results?: ExaResult[];
}

/** Coerces an arbitrary JSON value to a non-empty string, or `"unknown"`. */
function toMaybeString(value: unknown): Maybe<string> {
  if (typeof value !== "string") return UNKNOWN;
  const trimmed = value.trim();
  return trimmed === "" ? UNKNOWN : trimmed;
}

export class ExaSearchProvider implements SearchProvider {
  readonly name = "exa" as const;

  async search(
    query: string,
    opts?: { maxResults?: number; site?: string },
  ): Promise<SearchHit[]> {
    const config = getConfig();
    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

    const body: Record<string, unknown> = {
      query,
      numResults: maxResults,
    };
    if (opts?.site !== undefined && opts.site.trim() !== "") {
      body.includeDomains = [opts.site.trim()];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(EXA_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.searchApiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Exa search failed with status ${response.status}`);
      }

      const data = (await response.json()) as ExaResponse;
      const results = Array.isArray(data.results) ? data.results : [];

      return results.slice(0, maxResults).map((result) => {
        const snippet =
          toMaybeString(result.snippet) === UNKNOWN
            ? toMaybeString(result.text)
            : toMaybeString(result.snippet);
        return {
          url: toMaybeString(result.url) === UNKNOWN ? "" : String(result.url),
          title: toMaybeString(result.title),
          snippet,
          publishedDate: toMaybeString(result.publishedDate),
        };
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
