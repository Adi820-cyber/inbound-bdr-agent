/**
 * Property 11 — Verified status holds if and only if the source URL is in the
 * run's fetch ledger with a success status.
 *
 * **Validates: Requirements 4.7, 4.9, 5.1, 5.2, 5.3**
 *
 * `applyProvenanceFilter` is the orchestrator-side anti-fabrication gate. The
 * `isLedgered` predicate is the ONE authority that can accept a URL, and this
 * test controls it directly (it is just a `(url: string) => boolean`). The
 * property nails down the biconditional the requirements demand:
 *
 *   - **Only-if:** every surviving claim marked `verified` cites a `sourceUrl`
 *     for which `isLedgered` returns true and which is a real (non-empty,
 *     non-`"unknown"`) string (Req 4.7, 5.1).
 *   - **If / rejection:** every input claim that presented itself as `verified`
 *     but whose `sourceUrl` was NOT ledgered-with-success is rejected — its
 *     `claimText` and `sourceUrl` collapse to `"unknown"`, its
 *     `verificationStatus` becomes `"unknown"`, and it carries a
 *     `rejectionReason` (Req 5.2, 5.3).
 *   - **Acceptance:** a `verified` claim whose `sourceUrl` IS ledgered survives
 *     unchanged in status and URL, keeping its ledger-sourced `retrievedAt`
 *     (Req 4.9).
 *
 * `applyProvenanceFilter` maps claims one-to-one (`report.claims.map`), so the
 * output claim at index `i` corresponds to the input claim at index `i`; the
 * test walks the two lists in lockstep. A claim that was not `verified` to begin
 * with is not asserting verification and is therefore never rejected — the
 * rejection obligation is scoped to originally-`verified` claims, exactly as the
 * implementation and Req 5.2 define it.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN, type ResearchReport, type StageEvent } from "@/agent/contracts";
import { applyProvenanceFilter, type IsLedgered } from "@/agent/provenance";
import { arbResearchReport, arbUrl } from "./arbitraries";

type EmittedEvent = Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">;

/**
 * Mirrors `provenance.ts`'s internal `isLedgeredSource`: the `"unknown"` marker
 * and empty/whitespace URLs are NEVER ledgered, regardless of the predicate, and
 * only a concrete string is offered to `isLedgered`.
 */
function ledgeredSuccess(sourceUrl: string, isLedgered: IsLedgered): boolean {
  if (typeof sourceUrl !== "string") return false;
  if (sourceUrl === UNKNOWN || sourceUrl.trim().length === 0) return false;
  return isLedgered(sourceUrl);
}

/** Collect every candidate source URL a report presents (claims + figures). */
function collectUrls(report: ResearchReport): string[] {
  const urls: string[] = [];
  for (const claim of report.claims) {
    if (typeof claim.sourceUrl === "string") urls.push(claim.sourceUrl);
    for (const figure of claim.numericFigures) urls.push(figure.sourceUrl);
  }
  return urls;
}

/**
 * A report paired with a concrete set of ledgered-with-success URLs. The set is
 * a random subset of the report's own URLs (to exercise the acceptance branch)
 * unioned with arbitrary extra URLs (so the predicate is genuinely arbitrary and
 * the rejection branch is exercised too).
 */
const arbScenario: fc.Arbitrary<{ report: ResearchReport; ledgered: Set<string> }> =
  arbResearchReport.chain((report) => {
    const reportUrls = collectUrls(report);
    const ledgeredArb =
      reportUrls.length > 0
        ? fc
            .tuple(fc.subarray(reportUrls), fc.array(arbUrl, { maxLength: 5 }))
            .map(([subset, extra]) => [...subset, ...extra])
        : fc.array(arbUrl, { maxLength: 5 });
    return fc.record({
      report: fc.constant(report),
      ledgered: ledgeredArb.map((urls) => new Set(urls)),
    });
  });

describe("Property 11: verified iff source URL ledgered with success", () => {
  it("verified survivors are ledgered; unledgered verified claims are rejected", () => {
    fc.assert(
      fc.property(arbScenario, ({ report, ledgered }) => {
        const isLedgered: IsLedgered = (url) => ledgered.has(url);
        const events: EmittedEvent[] = [];
        const emit = (event: EmittedEvent) => events.push(event);

        const filtered = applyProvenanceFilter(report, isLedgered, emit);

        // The filter is one-to-one and never drops or reorders claims.
        expect(filtered.claims.length).toBe(report.claims.length);

        let expectedRejections = 0;

        for (let i = 0; i < report.claims.length; i++) {
          const input = report.claims[i]!;
          const output = filtered.claims[i]!;

          // (1) Only-if: any output claim that is still "verified" must cite a
          //     real, ledgered-with-success URL.
          if (output.verificationStatus === "verified") {
            expect(typeof output.sourceUrl).toBe("string");
            expect(output.sourceUrl).not.toBe(UNKNOWN);
            expect((output.sourceUrl as string).trim().length).toBeGreaterThan(0);
            expect(isLedgered(output.sourceUrl as string)).toBe(true);
          }

          if (input.verificationStatus === "verified") {
            if (ledgeredSuccess(input.sourceUrl as string, isLedgered)) {
              // (3) Acceptance: a ledgered verified claim survives unchanged.
              expect(output.verificationStatus).toBe("verified");
              expect(output.sourceUrl).toBe(input.sourceUrl);
              expect(output.claimText).toBe(input.claimText);
              expect(output.retrievedAt).toBe(input.retrievedAt);
            } else {
              // (2) Rejection: an unledgered verified claim collapses to unknown.
              expectedRejections += 1;
              expect(output.verificationStatus).toBe("unknown");
              expect(output.claimText).toBe(UNKNOWN);
              expect(output.sourceUrl).toBe(UNKNOWN);
              expect(typeof output.rejectionReason).toBe("string");
              expect((output.rejectionReason as string).length).toBeGreaterThan(0);
            }
          } else {
            // Non-verified claims are not asserting verification: they are never
            // rejected and keep their (non-verified) status.
            expect(output.verificationStatus).not.toBe("verified");
          }
        }

        // Each rejection emits exactly one validation_error naming the URL.
        const rejectionEvents = events.filter((e) => e.type === "validation_error");
        expect(rejectionEvents.length).toBe(expectedRejections);
      }),
      { numRuns: 400 },
    );
  });
});
