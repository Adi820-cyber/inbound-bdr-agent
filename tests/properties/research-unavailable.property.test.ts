/**
 * Property 17 — Zero verified research degrades the sequence honestly.
 *
 * **Validates: Requirements 6.7**
 *
 * When Stage 3 runs with NO verified research claims — whether the upstream
 * report carries only unverified/stale claims, carries no claims at all, or is
 * entirely absent (`"unknown"`) — the responder must degrade honestly rather
 * than fabricate evidence. Driving the REAL `stage3Responder.run` through a
 * stub LLM, this suite asserts that for every such input the produced sequence:
 *
 *   - sets `researchUnavailableNotice` to a NON-`"unknown"`, non-empty string
 *     (Req 6.7), signalling that no verified research backs the copy; and
 *   - still validates against `emailSequenceSchema` — the structural contract
 *     never degrades even when research does.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  QualificationResult,
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

/** Scripted generation matching the stage's internal generation schema. */
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
      progressionRationale: "Builds on the opener.",
    },
    {
      subject: "Closing the loop",
      body: "Third email body.",
      sendTimingGuidance: "Day 7",
      referencedClaimIds: [] as string[],
      progressionRationale: "Builds on the second email.",
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

/** A NON-verified (unknown | stale) claim with a guaranteed non-empty id. */
const arbUnverifiedClaim: fc.Arbitrary<ResearchClaim> = fc.record({
  claimId: arbNonEmptyClaimId,
  dimension: arbDimension,
  claimText: fc.oneof(fc.string(), fc.constant(UNKNOWN)),
  sourceUrl: fc.constant(UNKNOWN),
  supportingQuote: fc.constant(UNKNOWN),
  retrievedAt: fc.constant(UNKNOWN),
  verificationStatus: fc.constantFrom("unknown" as const, "stale" as const),
  numericFigures: fc.constant([]),
});

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
    verifiedClaimCount: 0,
  };
}

/**
 * Research with ZERO verified claims: a report of only unverified/stale claims
 * (possibly empty), or an absent report (`"unknown"`). Every branch drives the
 * research-unavailable path.
 */
const arbResearchWithoutVerified: fc.Arbitrary<ResearchReport | "unknown"> = fc.oneof(
  fc.array(arbUnverifiedClaim, { maxLength: 6 }).map(makeReport),
  fc.constant(UNKNOWN),
);

describe("Property 17: zero verified research degrades the sequence honestly (Req 6.7)", () => {
  it("sets a non-unknown researchUnavailableNotice and still validates the sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLeadProfile,
        arbQualificationResult,
        arbResearchWithoutVerified,
        async (lead, qualification: QualificationResult, research) => {
          const ctx: StageContext = {
            runId: "run_prop17",
            leadProfile: lead,
            toolbelt: NOOP_TOOLBELT,
            llm: createStubLlmProvider({ respondWith: GENERATION }),
            emit: () => {},
            attempt: 1,
            upstream: { qualification, research },
          };

          const sequence = await stage3Responder.run(ctx);

          // The sequence still validates its full structural contract.
          expect(() => emailSequenceSchema.parse(sequence)).not.toThrow();

          // Req 6.7: the notice is set to a non-"unknown", non-empty string.
          expect(sequence.researchUnavailableNotice).not.toBe(UNKNOWN);
          expect(typeof sequence.researchUnavailableNotice).toBe("string");
          expect((sequence.researchUnavailableNotice as string).length).toBeGreaterThan(
            0,
          );
        },
      ),
    );
  });
});
