/**
 * Property 9 — Unsupported dimensions yield exactly one unknown claim.
 *
 * **Validates: Requirements 4.8**
 *
 * When a searched dimension surfaces no usable source (its searches return
 * nothing and/or its fetches produce no readable page), Stage 2 must emit for
 * that dimension EXACTLY ONE claim whose `claimText` is `"unknown"` and whose
 * `verificationStatus` is `"unknown"`, and must record the dimension in
 * `dimensionsWithNoSource`. No source ⇒ no fabricated fact.
 *
 * Here the stub search returns `[]` for every query, so all four searched
 * dimensions are unsupported for arbitrary leads. We assert the exactly-one
 * unknown-claim shape for each, that every dimension appears in
 * `dimensionsWithNoSource`, and that `verifiedClaimCount` is 0.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN } from "@/agent/contracts";
import {
  SEARCHED_DIMENSIONS,
  stage2Researcher,
} from "@/agent/stages/stage-2-researcher";
import { createStage2Harness } from "@tests/support/stage2-harness";

import { arbLeadProfile } from "./arbitraries";

describe("Property 9: unsupported dimensions yield exactly one unknown claim (Req 4.8)", () => {
  it("emits exactly one unknown claim per unsupported dimension for arbitrary leads", async () => {
    await fc.assert(
      fc.asyncProperty(arbLeadProfile, async (lead) => {
        // Search returns nothing -> every searched dimension is unsupported.
        const { ctx } = createStage2Harness({ lead, search: [] });

        const report = await stage2Researcher.run(ctx);

        for (const dimension of SEARCHED_DIMENSIONS) {
          const claimsForDimension = report.claims.filter(
            (c) => c.dimension === dimension,
          );

          // Exactly one claim for the dimension.
          expect(claimsForDimension).toHaveLength(1);

          const claim = claimsForDimension[0]!;
          expect(claim.claimText).toBe(UNKNOWN);
          expect(claim.verificationStatus).toBe("unknown");

          // The dimension is flagged as having no source.
          expect(report.dimensionsWithNoSource).toContain(dimension);

          // claimsByDimension points at exactly that one unknown claim.
          expect(report.claimsByDimension[dimension]).toEqual([claim.claimId]);
        }

        // Nothing was verified when no dimension had a source.
        expect(report.verifiedClaimCount).toBe(0);
        expect(
          report.claims.every((c) => c.verificationStatus === "unknown"),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
