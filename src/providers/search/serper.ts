/**
 * Serper (Google SERP) search adapter (Req 13.5).
 *
 * Implements {@link SearchProvider} against Serper's `/search` endpoint. The API
 * key and per-request timeout come exclusively from `getConfig()` — this module
 * never reads `process.env` directly (Req 14.6). Serper has no structured
 * domain-restriction field, so `site` is folded into the query as a `site:`
 * operator. Mapping to {@link SearchHit} is total: any omitted field becomes the
 * literal `"unknown"`.
 */

import { UNKNOWN, type Maybe, type SearchHit, type SearchProvider } from "@/agent/contracts";
import { getConfig } from "@/lib/config/env";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const DEFAULT_MAX_RESULTS = 5;

interface SerperOrganicResult {
  link?: unknown;
  title?: unknown;
  snippet?: unknown;
  date?: unknown;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
}

/** Coerces an arbitrary JSON value to a non-empty string, or `"unknown"`. */
function toMaybeString(value: unknown): Maybe<string> {
  if (typeof value !== "string") return UNKNOWN;
  const trimmed = value.trim();
  return trimmed === "" ? UNKNOWN : trimmed;
}

export class SerperSearchProvider implements SearchProvider {
  readonly name = "serper" as const;

  async search(
    query: string,
    opts?: { maxResults?: number; site?: string },
  ): Promise<SearchHit[]> {
    const config = getConfig();
    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

    const site = opts?.site?.trim();
    const q = site !== undefined && site !== "" ? `${query} site:${site}` : query;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(SERPER_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": config.searchApiKey,
        },
        body: JSON.stringify({ q, num: maxResults }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Serper search failed with status ${response.status}`);
      }

      const data = (await response.json()) as SerperResponse;
      const organic = Array.isArray(data.organic) ? data.organic : [];

      return organic.slice(0, maxResults).map((result) => ({
        url: toMaybeString(result.link) === UNKNOWN ? "" : String(result.link),
        title: toMaybeString(result.title),
        snippet: toMaybeString(result.snippet),
        publishedDate: toMaybeString(result.date),
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
