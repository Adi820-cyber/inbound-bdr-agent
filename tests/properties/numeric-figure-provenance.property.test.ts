/**
 * Property 13 — Numeric figures carry their own ledgered source URL.
 *
 * **Validates: Requirements 5.6**
 *
 * A numeric figure must cite the page it was retrieved from; a figure that
 * cannot name a ledgered-with-success URL is dropped rather than displayed
 * unsourced. This holds for figures on EVERY claim, whatever the claim's own
 * verification status — the figure filter runs before the claim-level check.
 *
 * The test controls `isLedgered` directly (it is just a
 * `(url: string) => boolean`) and asserts two things after
 * `applyProvenanceFilter`:
 *
 *   - **Survival:** every `NumericFigure` still present on any claim has a
 *     `sourceUrl` that is a real (non-empty, non-`"unknown"`) string for which
 *     `isLedgered` returns true.
 *   - **Exactness:** the figures kept on each claim are precisely the input
 *     figures whose `sourceUrl` was ledgered-with-success — nothing ledgered is
 *     dropped and nothing unledgered survives.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN, type ResearchReport, type StageEvent } from "@/agent/contracts";
import { applyProvenanceFilter, type IsLedgered } from "@/agent/provenance";
import { arbResearchReport, arbUrl } from "./arbitraries";

type EmittedEvent = Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">;

/** Mirrors `provenance.ts`'s `isLedgeredSource`: marker/empty never ledgered. */
function ledgeredSuccess(sourceUrl: string, isLedgered: IsLedgered): boolean {
  if (typeof sourceUrl !== "string") return false;
  if (sourceUrl === UNKNOWN || sourceUrl.trim().length === 0) return false;
  return isLedgered(sourceUrl);
}

/** A report paired with a concrete ledgered-URL set drawn partly from its own figures. */
const arbScenario: fc.Arbitrary<{ report: ResearchReport; ledgered: Set<string> }> =
  arbResearchReport.chain((report) => {
    const figureUrls: string[] = [];
    for (const claim of report.claims) {
      for (const figure of claim.numericFigures) figureUrls.push(figure.sourceUrl);
    }
    const ledgeredArb =
      figureUrls.length > 0
        ? fc
            .tuple(fc.subarray(figureUrls), fc.array(arbUrl, { maxLength: 5 }))
            .map(([subset, extra]) => [...subset, ...extra])
        : fc.array(arbUrl, { maxLength: 5 });
    return fc.record({
      report: fc.constant(report),
      ledgered: ledgeredArb.map((urls) => new Set(urls)),
    });
  });

describe("Property 13: numeric figures carry their own ledgered source URL", () => {
  it("surviving figures are ledgered, and kept figures are exactly the ledgered inputs", () => {
    fc.assert(
      fc.property(arbScenario, ({ report, ledgered }) => {
        const isLedgered: IsLedgered = (url) => ledgered.has(url);
        const emit = (_event: EmittedEvent) => {};

        const filtered = applyProvenanceFilter(report, isLedgered, emit);

        expect(filtered.claims.length).toBe(report.claims.length);

        for (let i = 0; i < report.claims.length; i++) {
          const input = report.claims[i]!;
          const output = filtered.claims[i]!;

          // Survival: every surviving figure cites a real, ledgered URL.
          for (const figure of output.numericFigures) {
            expect(typeof figure.sourceUrl).toBe("string");
            expect(figure.sourceUrl).not.toBe(UNKNOWN);
            expect(figure.sourceUrl.trim().length).toBeGreaterThan(0);
            expect(isLedgered(figure.sourceUrl)).toBe(true);
          }

          // Exactness: kept figures == input figures with a ledgered source URL.
          const expectedKept = input.numericFigures.filter((f) =>
            ledgeredSuccess(f.sourceUrl, isLedgered),
          );
          expect(output.numericFigures).toEqual(expectedKept);
        }
      }),
      { numRuns: 400 },
    );
  });
});
