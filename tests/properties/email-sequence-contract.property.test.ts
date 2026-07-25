/**
 * Property 16 — The email sequence satisfies its structural contract.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
 *
 * Stage 3 is "deterministic pre-planning, one LLM generation call, then
 * deterministic post-processing that forces every schema-critical invariant to
 * hold". Driving the REAL `stage3Responder.run` through a stub LLM (the single
 * schema-constrained call) — for arbitrary qualification results (varying
 * `unknownFields`) and research reports carrying at least one verified claim —
 * this suite pins down the full structural contract of the produced
 * `EmailSequence`:
 *
 *   - it validates against `emailSequenceSchema` (Req 6.1: exactly three drafts);
 *   - each draft targets 1..2 unknown slot ids (Req 6.3);
 *   - each draft references >= 1 claim id, and every referenced id resolves to a
 *     real claim id present in the research report (Req 6.2);
 *   - the sequence covers >= 3 DISTINCT unknown slot ids (Req 6.4);
 *   - `progressionRationale` is `"unknown"` on draft 1 and a non-`"unknown"`
 *     string on drafts 2 and 3 (Req 6.5).
 *
 * The stub LLM deliberately returns EMPTY `referencedClaimIds`, so the resolvable
 * claim ids on every draft are produced by the stage's deterministic
 * post-processing, not by the model — exactly the guarantee the contract makes.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  ResearchClaim,
  ResearchReport,
  ResearchToolbelt,
  StageContext,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { emailSequenceSchema } from "@/agent/schemas";
import { stage3Responder } from "@/agent/stages/stage-3-responder";
import { createStubLlmProvider } from "@tests/support/stub-llm";

import { arbLeadProfile, arbQualificationResult } from "./arbitraries";

/** Stage 3 declares `usesToolbelt: false`; a never-called toolbelt is fine. */
const NOOP_TOOLBELT = {} as unknown as ResearchToolbelt;

/**
 * A scripted generation matching the stage's internal generation schema:
 * a 3-tuple of drafts plus a persona note. `referencedClaimIds` are left EMPTY
 * on purpose so the deterministic post-processing supplies resolvable ids.
 */
const GENERATION = {
  emails: [
    {
      subject: "Opening the thread",
      body: "First email body.",
      sendTimingGuidance: "Day 0",
      referencedClaimIds: [] as string[],
      progressionRationale: "",
    },
    {
      subject: "Following up",
      body: "Second email body.",
      sendTimingGuidance: "Day 3",
      referencedClaimIds: [] as string[],
      progressionRationale: "Builds on the opener by going one level deeper.",
    },
    {
      subject: "Closing the loop",
      body: "Third email body.",
      sendTimingGuidance: "Day 7",
      referencedClaimIds: [] as string[],
      progressionRationale: "Builds on the second email with a concrete ask.",
    },
  ],
  personaAdaptationNote:
    "Concise, outcome-focused tone with practical technical depth for an operations leader.",
};

const arbNonEmptyClaimId: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => `claim_${s}`);

const arbDimension = fc.constantFrom(
  "org_structure" as const,
  "budget_signals" as const,
  "recent_news" as const,
  "leadership_language" as const,
  "positioning" as const,
);

/** A claim with the given verification status and a guaranteed non-empty id. */
function arbClaim(
  status: ResearchClaim["verificationStatus"],
): fc.Arbitrary<ResearchClaim> {
  return fc.record({
    claimId: arbNonEmptyClaimId,
    dimension: arbDimension,
    claimText: fc.oneof(fc.string(), fc.constant(UNKNOWN)),
    sourceUrl: fc.constant(UNKNOWN),
    supportingQuote: fc.constant(UNKNOWN),
    retrievedAt: fc.constant(UNKNOWN),
    verificationStatus: fc.constant(status),
    numericFigures: fc.constant([]),
  });
}

const arbAnyClaim: fc.Arbitrary<ResearchClaim> = fc.oneof(
  arbClaim("verified"),
  arbClaim("unknown"),
  arbClaim("stale"),
);

function makeReport(claims: ResearchClaim[]): ResearchReport {
  return {
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
    verifiedClaimCount: claims.filter((c) => c.verificationStatus === "verified")
      .length,
  };
}

/** A research report guaranteed to carry at least one verified claim. */
const arbResearchWithVerified: fc.Arbitrary<ResearchReport> = fc
  .tuple(
    fc.array(arbAnyClaim, { maxLength: 4 }),
    arbClaim("verified"),
    fc.array(arbAnyClaim, { maxLength: 4 }),
  )
  .map(([pre, verified, post]) => makeReport([...pre, verified, ...post]));

describe("Property 16: the email sequence satisfies its structural contract (Req 6.1-6.5)", () => {
  it("produces a schema-valid sequence with resolvable claims, 1..2 slots per draft, >=3 distinct coverage, and correct progression", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLeadProfile,
        arbQualificationResult,
        arbResearchWithVerified,
        async (lead, qualification, research) => {
          const ctx: StageContext = {
            runId: "run_prop16",
            leadProfile: lead,
            toolbelt: NOOP_TOOLBELT,
            llm: createStubLlmProvider({ respondWith: GENERATION }),
            emit: () => {},
            attempt: 1,
            upstream: { qualification, research },
          };

          const sequence = await stage3Responder.run(ctx);

          // Req 6.1 (and the full structural contract): validates the schema.
          expect(() => emailSequenceSchema.parse(sequence)).not.toThrow();

          // Exactly three drafts, positions 1, 2, 3 (Req 6.1).
          expect(sequence.emails).toHaveLength(3);
          expect(sequence.emails.map((e) => e.position)).toEqual([1, 2, 3]);

          // Every real claim id present in the report — the resolvable universe.
          const realClaimIds = new Set(
            research.claims
              .map((c) => c.claimId)
              .filter((id) => typeof id === "string" && id.length > 0),
          );

          for (const draft of sequence.emails) {
            // Each draft targets 1..2 unknown slot ids (Req 6.3).
            expect(draft.targetedUnknownSlotIds.length).toBeGreaterThanOrEqual(1);
            expect(draft.targetedUnknownSlotIds.length).toBeLessThanOrEqual(2);

            // Each draft references >= 1 claim id (Req 6.2)...
            expect(draft.referencedClaimIds.length).toBeGreaterThanOrEqual(1);
            // ...and every referenced id resolves to a real claim id (Req 6.2).
            for (const id of draft.referencedClaimIds) {
              expect(realClaimIds.has(id)).toBe(true);
            }
          }

          // Covers >= 3 DISTINCT unknown slot ids (Req 6.4).
          const distinctCovered = new Set(sequence.coveredUnknownSlotIds);
          expect(distinctCovered.size).toBeGreaterThanOrEqual(3);
          expect(distinctCovered.size).toBe(sequence.coveredUnknownSlotIds.length);

          // progressionRationale: "unknown" on draft 1, non-"unknown" on 2 and 3 (Req 6.5).
          expect(sequence.emails[0].progressionRationale).toBe(UNKNOWN);
          for (const draft of [sequence.emails[1], sequence.emails[2]]) {
            expect(typeof draft.progressionRationale).toBe("string");
            expect(draft.progressionRationale).not.toBe(UNKNOWN);
            expect((draft.progressionRationale as string).length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });
});
