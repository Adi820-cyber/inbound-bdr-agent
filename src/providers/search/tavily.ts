/**
 * Tavily search adapter (Req 13.5).
 *
 * Implements {@link SearchProvider} against Tavily's `/search` endpoint. The API
 * key and per-request timeout come exclusively from `getConfig()` — this module
 * never reads `process.env` directly (Req 14.6). Mapping to {@link SearchHit} is
 * total: any field Tavily omits becomes the literal `"unknown"` rather than
 * `null`, so hits round-trip through JSON and render directly in the UI.
 */

import { UNKNOWN, type Maybe, type SearchHit, type SearchProvider } from "@/agent/contracts";
import { getConfig } from "@/lib/config/env";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_MAX_RESULTS = 5;

interface TavilyResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

/** Coerces an arbitrary JSON value to a non-empty string, or `"unknown"`. */
function toMaybeString(value: unknown): Maybe<string> {
  if (typeof value !== "string") return UNKNOWN;
  const trimmed = value.trim();
  return trimmed === "" ? UNKNOWN : trimmed;
}

export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily" as const;

  async search(
    query: string,
    opts?: { maxResults?: number; site?: string },
  ): Promise<SearchHit[]> {
    const config = getConfig();
    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

    const body: Record<string, unknown> = {
      api_key: config.searchApiKey,
      query,
      max_results: maxResults,
    };
    if (opts?.site !== undefined && opts.site.trim() !== "") {
      body.include_domains = [opts.site.trim()];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.searchApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Tavily search failed with status ${response.status}`);
      }

      const data = (await response.json()) as TavilyResponse;
      const results = Array.isArray(data.results) ? data.results : [];

      return results.slice(0, maxResults).map((result) => ({
        url: toMaybeString(result.url) === UNKNOWN ? "" : String(result.url),
        title: toMaybeString(result.title),
        snippet: toMaybeString(result.content),
        publishedDate: toMaybeString(result.published_date),
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
