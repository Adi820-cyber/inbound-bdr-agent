/**
 * Property 8 — Every required research dimension is attempted.
 *
 * **Validates: Requirements 4.1**
 *
 * Stage 2 must issue at least one toolbelt search for every one of the four
 * searched dimensions (`org_structure`, `budget_signals`, `recent_news`,
 * `leadership_language`) — even for a fully-unknown lead where every request
 * degrades to an empty result. Because the REAL toolbelt and REAL fetch ledger
 * run here (only the network hops are stubbed), a search attempt is observable
 * as a `kind: "search"` ledger entry carrying the issued query.
 *
 * For arbitrary leads we run `stage2Researcher.run` with a search stub that
 * returns nothing, then assert that for each dimension at least one search
 * ledger entry exists whose query is one the dimension would build. The stub
 * search provider's recorded calls are cross-checked as a second witness.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SEARCHED_DIMENSIONS,
  buildAllDimensionQueries,
  stage2Researcher,
} from "@/agent/stages/stage-2-researcher";
import { createStage2Harness } from "@tests/support/stage2-harness";

import { arbLeadProfile } from "./arbitraries";

describe("Property 8: every required research dimension is attempted (Req 4.1)", () => {
  it("issues >= 1 toolbelt search per dimension for arbitrary leads", async () => {
    await fc.assert(
      fc.asyncProperty(arbLeadProfile, async (lead) => {
        // Search returns nothing so every dimension stays unsupported — the
        // hard case for Property 8: the attempt must still be made.
        const { ctx, toolbelt, searchProvider } = createStage2Harness({ lead });

        await stage2Researcher.run(ctx);

        const queriesByDimension = buildAllDimensionQueries(lead);
        const searchEntries = toolbelt
          .getLedger()
          .filter((entry) => entry.kind === "search");
        const ledgeredQueries = new Set(
          searchEntries
            .map((entry) => entry.query)
            .filter((q): q is string => typeof q === "string"),
        );
        const calledQueries = new Set(searchProvider.calls.map((c) => c.query));

        // At least 4 search entries in total (>= 1 per dimension).
        expect(searchEntries.length).toBeGreaterThanOrEqual(SEARCHED_DIMENSIONS.length);

        for (const dimension of SEARCHED_DIMENSIONS) {
          const dimensionQueries = queriesByDimension[dimension];
          expect(dimensionQueries.length).toBeGreaterThanOrEqual(1);

          // A search was ledgered for at least one of this dimension's queries.
          const ledgeredForDimension = dimensionQueries.some((q) =>
            ledgeredQueries.has(q),
          );
          expect(ledgeredForDimension).toBe(true);

          // And the provider actually received one of them.
          const calledForDimension = dimensionQueries.some((q) =>
            calledQueries.has(q),
          );
          expect(calledForDimension).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
