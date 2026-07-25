/**
 * Property 10 — Positioning assertions resolve to real claims.
 *
 * **Validates: Requirements 4.6**
 *
 * Every assertion in the synthesized `positioningRecommendation` must cite only
 * `supportingClaimIds` that resolve to claim ids actually emitted in the same
 * `ResearchReport`. The positioning LLM may return anything — including ids for
 * claims that were never emitted — but Stage 2 keeps only the resolvable ids and
 * drops any assertion left with none. An LLM can never smuggle a dangling
 * citation into the report.
 *
 * The stub LLM is scripted per run: the four extraction calls each return one
 * verifiable claim (grounded in a stubbed page), and the positioning call
 * returns fast-check-generated assertions whose citations mix REAL emitted claim
 * ids with fabricated ones. We assert that every surviving assertion cites only
 * real ids, and that exactly the assertions carrying >= 1 real id survive.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ZodType } from "zod";
import { SEARCHED_DIMENSIONS, stage2Researcher } from "@/agent/stages/stage-2-researcher";
import { createStage2Harness } from "@tests/support/stage2-harness";

const SOURCE_URL = "https://acme.example.com/report";
const PAGE_TEXT =
  "Acme Resources operates twelve continuous mining sites across the region and " +
  "reported record capital expenditure with growing technology investment.";
const SUPPORTING_QUOTE = "record capital expenditure";

/** The real claim ids Stage 2 emits given one verified claim per dimension. */
const REAL_CLAIM_IDS = SEARCHED_DIMENSIONS.map((d) => `claim_${d}_1`);

/** A citation id: either a real emitted id or a fabricated one. */
const arbClaimIdRef: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...REAL_CLAIM_IDS),
  fc.string({ minLength: 1 }).map((s) => `fake_${s}`),
);

/** One generated positioning assertion with a (possibly mixed/empty) citation list. */
interface AssertionSpec {
  assertion: string;
  supportingClaimIds: string[];
}

const arbAssertionSpec: fc.Arbitrary<AssertionSpec> = fc.record({
  assertion: fc.string({ minLength: 1 }),
  supportingClaimIds: fc.array(arbClaimIdRef, { maxLength: 5 }),
});

describe("Property 10: positioning assertions resolve to real claims (Req 4.6)", () => {
  it("keeps only assertions whose citations resolve to emitted claim ids", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAssertionSpec, { maxLength: 6 }),
        async (assertionSpecs) => {
          // Script the LLM: extraction calls yield a verifiable claim per
          // dimension; the positioning call returns the generated assertions.
          const llm = (args: {
            purpose: string;
            schema: ZodType;
          }): unknown => {
            if (args.purpose.startsWith("stage-2-extract-")) {
              return {
                claims: [
                  {
                    claimText: "Acme reported record capital expenditure.",
                    sourceUrl: SOURCE_URL,
                    supportingQuote: SUPPORTING_QUOTE,
                    numericFigures: [],
                  },
                ],
              };
            }
            if (args.purpose === "stage-2-positioning") {
              return {
                narrative: "FlytBase should lead with automation ROI.",
                assertions: assertionSpecs,
              };
            }
            return args.schema.parse(undefined);
          };

          const { ctx } = createStage2Harness({
            // Every query surfaces the one stubbed source; the page carries the quote.
            search: () => [
              { url: SOURCE_URL, title: "Acme report", snippet: null, publishedDate: null },
            ],
            pages: { [SOURCE_URL]: { text: PAGE_TEXT, contentType: "text/plain" } },
            llm: llm as never,
          });

          const report = await stage2Researcher.run(ctx);

          const emittedIds = new Set(report.claims.map((c) => c.claimId));
          const validRefs = new Set(REAL_CLAIM_IDS);

          // Sanity: the four dimensions each produced a real, verified claim.
          expect(report.verifiedClaimCount).toBe(SEARCHED_DIMENSIONS.length);
          for (const id of REAL_CLAIM_IDS) {
            expect(emittedIds.has(id)).toBe(true);
          }

          // CORE INVARIANT: every surviving assertion cites only emitted ids,
          // and always at least one (Req 4.6).
          for (const assertion of report.positioningRecommendation.assertions) {
            expect(assertion.supportingClaimIds.length).toBeGreaterThanOrEqual(1);
            for (const id of assertion.supportingClaimIds) {
              expect(emittedIds.has(id)).toBe(true);
            }
          }

          // COMPLETENESS: exactly the specs carrying >= 1 real id survive.
          const expectedSurviving = assertionSpecs.filter((spec) =>
            spec.supportingClaimIds.some((id) => validRefs.has(id)),
          ).length;
          expect(report.positioningRecommendation.assertions).toHaveLength(
            expectedSurviving,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
