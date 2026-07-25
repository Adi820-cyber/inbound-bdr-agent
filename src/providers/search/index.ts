/**
 * Search provider factory (Req 13.5).
 *
 * The single construction point for the {@link SearchProvider} adapter. Selection
 * is driven entirely by `getConfig().searchProvider`, which resolves the
 * `SEARCH_PROVIDER` selector through the config module — no module here reads
 * `process.env` directly. The `SEARCH_PROVIDERS` enum in the config module and
 * the `SearchProvider["name"]` union in the contracts are kept exhaustively in
 * sync by the `switch` below: an unhandled case is a compile error.
 */

import type { SearchProvider } from "@/agent/contracts";
import { getConfig } from "@/lib/config/env";
import { ExaSearchProvider } from "./exa";
import { SerperSearchProvider } from "./serper";
import { TavilySearchProvider } from "./tavily";

export { ExaSearchProvider } from "./exa";
export { SerperSearchProvider } from "./serper";
export { TavilySearchProvider } from "./tavily";

/**
 * Builds the {@link SearchProvider} selected by `SEARCH_PROVIDER`. Any unknown
 * selector value has already been rejected by the config module's startup
 * validation, so the fall-through here is unreachable in practice.
 */
export function createSearchProvider(): SearchProvider {
  const { searchProvider } = getConfig();
  switch (searchProvider) {
    case "tavily":
      return new TavilySearchProvider();
    case "exa":
      return new ExaSearchProvider();
    case "serper":
      return new SerperSearchProvider();
    default: {
      const exhaustive: never = searchProvider;
      throw new Error(`Unsupported search provider: ${String(exhaustive)}`);
    }
  }
}
