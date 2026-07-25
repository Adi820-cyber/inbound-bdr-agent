/**
 * Property 28 — The handoff summary is derived and adds nothing.
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7**
 *
 * Stage 6 is a *pure derivation* over the outputs of stages 1 through 5: it
 * introduces no new fact, issues no toolbelt call, and cites no URL that did not
 * already appear upstream. Driving the REAL `stage6HandoffGenerator.run` through
 * a stub LLM (the single, prose-only call) for arbitrary upstream outputs — a
 * `QualificationResult`, a `ResearchReport` whose verified-finding count varies
 * across 0..5, a `MatchResult` whose winner is present or `"unknown"`, and a
 * `GtmRecommendation` — this suite pins down the derivation contract of the
 * produced `HandoffSummary`:
 *
 *   - it validates against `handoffSummarySchema` (Req 10.1);
 *   - the qualification status mirrors Stage 1 exactly — framework, priority
 *     score, fit, known-field count (= `knownFields.length`) and the unknown
 *     slot labels (Req 10.2);
 *   - `topThreeFindings` always has exactly three entries, each carrying a
 *     `sourceUrl` field (Req 10.3);
 *   - when fewer than three verified findings exist the remaining entries are the
 *     `"unknown"` marker, and `verifiedFindingsAvailable` equals the actual
 *     verified count (Req 10.7);
 *   - the recommended case study reflects the Stage 4 winner (its `sourceUrl` /
 *     `title`) or is entirely `"unknown"` when there is no winner (Req 10.4);
 *   - `suggestedNextStep.consistentWithMotion` equals the Stage 5 motion
 *     (Req 10.5);
 *   - every source URL that appears in the summary already appeared in an
 *     upstream output — the derivation-only guarantee (Req 10.6).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  GtmRecommendation,
  MatchResult,
  QualificationResult,
  ResearchClaim,
  ResearchReport,
  ResearchToolbelt,
  StageContext,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { handoffSummarySchema } from "@/agent/schemas";
import { stage6HandoffGenerator } from "@/agent/stages/stage-6-handoff-generator";
import { createStubLlmProvider } from "@tests/support/stub-llm";

import {
  arbGtmRecommendation,
  arbMatchResult,
  arbQualificationResult,
} from "./arbitraries";

/** Stage 6 declares `usesToolbelt: false`; a never-called toolbelt is fine. */
const NOOP_TOOLBELT = {} as unknown as ResearchToolbelt;

const arbDimension = fc.constantFrom(
  "org_structure" as const,
  "budget_signals" as const,
  "recent_news" as const,
  "leadership_language" as const,
  "positioning" as const,
);

/**
 * A claim that qualifies as a "verified finding" under Stage 6's rule: verified
 * status, a known (non-empty, non-`"unknown"`) claim text, and a real source
 * URL. Every such claim contributes exactly one to `verifiedFindingsAvailable`.
 */
const arbVerifiedFinding: fc.Arbitrary<ResearchClaim> = fc.record({
  claimId: fc.string({ minLength: 1, maxLength: 10 }).map((s) => `claim_v_${s}`),
  dimension: arbDimension,
  claimText: fc.string({ minLength: 1, maxLength: 40 }).map((s) => `finding: ${s}`),
  sourceUrl: fc.webUrl(),
  supportingQuote: fc.oneof(fc.string(), fc.constant(UNKNOWN)),
  retrievedAt: fc.constant("2024-01-01T00:00:00.000Z"),
  verificationStatus: fc.constant("verified" as const),
  numericFigures: fc.constant([]),
});

/**
 * A claim that is NOT a verified finding: its status is `unknown`/`stale`, so it
 * can never be counted, whatever its text or URL. Its URL still lands in the
 * upstream URL set for the derivation-only check.
 */
const arbNonFinding: fc.Arbitrary<ResearchClaim> = fc.record({
  claimId: fc.string({ minLength: 1, maxLength: 10 }).map((s) => `claim_n_${s}`),
  dimension: arbDimension,
  claimText: fc.oneof(fc.string(), fc.constant(UNKNOWN)),
  sourceUrl: fc.oneof(fc.webUrl(), fc.constant(UNKNOWN), fc.constant("")),
  supportingQuote: fc.oneof(fc.string(), fc.constant(UNKNOWN)),
  retrievedAt: fc.oneof(fc.constant("2024-01-01T00:00:00.000Z"), fc.constant(UNKNOWN)),
  verificationStatus: fc.constantFrom("unknown" as const, "stale" as const),
  numericFigures: fc.constant([]),
});

/**
 * A research report whose verified-finding count is a controlled value in 0..5,
 * mixed with an arbitrary number of non-findings so the count is exercised
 * independently of the report's overall size.
 */
const arbResearchReport: fc.Arbitrary<{ report: ResearchReport; verifiedCount: number }> =
  fc
    .tuple(
      fc.array(arbVerifiedFinding, { minLength: 0, maxLength: 5 }),
      fc.array(arbNonFinding, { minLength: 0, maxLength: 5 }),
    )
    .chain(([verified, nonFindings]) =>
      // Interleave deterministically by a shuffled index list so ordering varies.
      fc
        .shuffledSubarray([...verified, ...nonFindings], {
          minLength: verified.length + nonFindings.length,
          maxLength: verified.length + nonFindings.length,
        })
        .map((claims) => ({
          report: {
            claims,
            claimsByDimension: {
              org_structure: [],
              budget_signals: [],
              recent_news: [],
              leadership_language: [],
              positioning: [],
            },
            positioningRecommendation: { narrative: "", assertions: [] },
            dimensionsWithNoSource: [],
            verifiedClaimCount: verified.length,
          } satisfies ResearchReport,
          verifiedCount: verified.length,
        })),
    );

/** Collect every source URL that appears anywhere in the upstream outputs. */
function collectUpstreamUrls(
  research: ResearchReport,
  match: MatchResult,
  gtm: GtmRecommendation,
): Set<string> {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") urls.add(value);
  };

  for (const claim of research.claims) {
    add(claim.sourceUrl);
    for (const figure of claim.numericFigures) add(figure.sourceUrl);
  }

  for (const scored of match.rankedCorpus) add(scored.record.sourceUrl);
  if (match.winner !== UNKNOWN) add(match.winner.record.sourceUrl);
  if (match.runnerUp !== UNKNOWN) add(match.runnerUp.record.sourceUrl);

  if (gtm.regionalPartnerEvidence !== UNKNOWN) {
    add(gtm.regionalPartnerEvidence.sourceUrl);
  }

  return urls;
}

const UNKNOWN_MARKER = {
  claimId: UNKNOWN,
  finding: UNKNOWN,
  sourceUrl: UNKNOWN,
};

describe("Property 28: the handoff summary is derived from stages 1-5 and adds nothing (Req 10.1-10.7)", () => {
  it("mirrors qualification, derives findings/case-study/motion, and cites no new URL", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbQualificationResult,
        arbResearchReport,
        arbMatchResult,
        arbGtmRecommendation,
        async (
          qualification: QualificationResult,
          { report: research, verifiedCount },
          match: MatchResult,
          gtm: GtmRecommendation,
        ) => {
          const ctx: StageContext = {
            runId: "run_prop28",
            leadProfile: {
              leadId: "lead_prop28",
              senderName: UNKNOWN,
              senderEmail: UNKNOWN,
              title: UNKNOWN,
              division: UNKNOWN,
              company: UNKNOWN,
              companyDomain: UNKNOWN,
              country: UNKNOWN,
              region: UNKNOWN,
              industry: UNKNOWN,
              statedUseCase: UNKNOWN,
              statedPainPoints: [],
              referralSource: UNKNOWN,
              statedTimeline: UNKNOWN,
              siteCount: UNKNOWN,
              rawEmail: {
                fromName: "n",
                fromEmail: "e",
                subject: "s",
                body: "b",
              },
              normalizedAt: "2024-01-01T00:00:00.000Z",
            },
            toolbelt: NOOP_TOOLBELT,
            llm: createStubLlmProvider(),
            emit: () => {},
            attempt: 1,
            upstream: { qualification, research, match, gtm },
          };

          const summary = await stage6HandoffGenerator.run(ctx);

          // Req 10.1: the produced summary validates the handoff schema.
          expect(() => handoffSummarySchema.parse(summary)).not.toThrow();

          // Req 10.2: qualification status mirrors Stage 1 exactly.
          expect(summary.qualificationStatus.framework).toBe(qualification.framework);
          expect(summary.qualificationStatus.priorityScore).toBe(
            qualification.priorityScore,
          );
          expect(summary.qualificationStatus.fitAssessment).toBe(
            qualification.fitAssessment,
          );
          expect(summary.qualificationStatus.knownFieldCount).toBe(
            qualification.knownFields.length,
          );
          expect(summary.qualificationStatus.unknownSlotLabels).toEqual(
            qualification.unknownFields.map((f) => f.slotLabel),
          );

          // Req 10.3: exactly three findings, each carrying a sourceUrl field.
          expect(summary.topThreeFindings).toHaveLength(3);
          for (const finding of summary.topThreeFindings) {
            expect(typeof finding.sourceUrl).toBe("string");
          }

          // Req 10.7: verifiedFindingsAvailable equals the actual verified count.
          expect(summary.verifiedFindingsAvailable).toBe(verifiedCount);

          // Findings drawn from verified claims carry a real URL; the remaining
          // slots (when fewer than three verified) are the "unknown" marker.
          const verifiedIds = new Set(
            research.claims
              .filter(
                (c) =>
                  c.verificationStatus === "verified" &&
                  c.claimText !== UNKNOWN &&
                  c.claimText.trim().length > 0 &&
                  c.sourceUrl !== UNKNOWN &&
                  c.sourceUrl.trim().length > 0,
              )
              .map((c) => c.claimId),
          );
          const filled = Math.min(verifiedCount, 3);
          summary.topThreeFindings.forEach((finding, index) => {
            if (index < filled) {
              expect(finding.finding).not.toBe(UNKNOWN);
              expect(finding.sourceUrl).not.toBe(UNKNOWN);
              expect((finding.sourceUrl as string).length).toBeGreaterThan(0);
              expect(verifiedIds.has(finding.claimId as string)).toBe(true);
            } else {
              expect(finding).toEqual(UNKNOWN_MARKER);
            }
          });

          // Req 10.4: recommended case study reflects the Stage 4 winner, or is
          // entirely "unknown" when there is no winner.
          if (match.winner === UNKNOWN) {
            expect(summary.recommendedCaseStudy.sourceUrl).toBe(UNKNOWN);
            expect(summary.recommendedCaseStudy.title).toBe(UNKNOWN);
            expect(summary.recommendedCaseStudy.whyItWon).toBe(UNKNOWN);
          } else {
            expect(summary.recommendedCaseStudy.sourceUrl).toBe(
              match.winner.record.sourceUrl,
            );
            expect(summary.recommendedCaseStudy.title).toBe(match.winner.record.title);
          }

          // Req 10.5: the suggested next step is consistent with the Stage 5 motion.
          expect(summary.suggestedNextStep.consistentWithMotion).toBe(gtm.motion);

          // Req 10.6: no source URL in the summary that was absent upstream.
          const upstreamUrls = collectUpstreamUrls(research, match, gtm);
          const summaryUrls = [
            ...summary.topThreeFindings.map((f) => f.sourceUrl),
            summary.recommendedCaseStudy.sourceUrl,
          ];
          for (const url of summaryUrls) {
            if (url === UNKNOWN) continue;
            expect(upstreamUrls.has(url as string)).toBe(true);
          }
        },
      ),
    );
  });
});
