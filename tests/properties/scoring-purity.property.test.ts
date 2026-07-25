/**
 * Property 22 — Scoring is a pure function of lead and case-study fields.
 *
 * **Validates: Requirements 8.1**
 *
 * `scoreCaseStudy(lead, caseStudy)` must depend ONLY on the lead-attribute
 * values and case-study field values it actually compares. This suite asserts
 * three facets of that purity:
 *
 *   1. Determinism — scoring the same (or a deep-cloned) input twice yields a
 *      deep-equal `ScoreBreakdown`. There is no hidden state, clock, or RNG.
 *   2. Non-mutation — the function does not mutate either argument. Inputs are
 *      deeply frozen (any write would throw) and additionally deep-compared
 *      before/after.
 *   3. Irrelevant-field independence — varying fields the rubric never reads
 *      (leadId, senderName, senderEmail, normalizedAt, rawEmail on the lead;
 *      verificationStatus, retrievedAt, sourceUrl on the case study) leaves the
 *      `ScoreBreakdown` unchanged.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CaseStudyRecord, LeadProfile } from "@/agent/contracts";
import { scoreCaseStudy } from "@/agent/stages/stage-4/scoring-rubric";
import {
  arbCaseStudyRecord,
  arbEdgeString,
  arbLeadProfile,
} from "./arbitraries";

/** Recursively freeze an object so any mutation attempt throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

describe("Property 22: scoring purity (Req 8.1)", () => {
  it("is deterministic — same inputs produce deep-equal breakdowns", () => {
    fc.assert(
      fc.property(arbLeadProfile, arbCaseStudyRecord, (lead, caseStudy) => {
        const first = scoreCaseStudy(lead, caseStudy);
        // Deep-clone the inputs so the second call cannot share any reference.
        const second = scoreCaseStudy(
          structuredClone(lead),
          structuredClone(caseStudy),
        );
        expect(second).toStrictEqual(first);
      }),
    );
  });

  it("does not mutate its inputs (frozen inputs, unchanged snapshots)", () => {
    fc.assert(
      fc.property(arbLeadProfile, arbCaseStudyRecord, (lead, caseStudy) => {
        const leadBefore = structuredClone(lead);
        const caseStudyBefore = structuredClone(caseStudy);

        // Frozen inputs: a stray write inside the rubric would throw here.
        scoreCaseStudy(deepFreeze(lead), deepFreeze(caseStudy));

        // Belt-and-braces: the argument values are unchanged afterward.
        // `toEqual` compares values structurally (prototype-agnostic) because
        // `structuredClone` does not preserve a null prototype, which fast-check
        // may attach to generated records.
        expect(lead).toEqual(leadBefore);
        expect(caseStudy).toEqual(caseStudyBefore);
      }),
    );
  });

  it("ignores lead fields the rubric never reads", () => {
    fc.assert(
      fc.property(
        arbLeadProfile,
        arbCaseStudyRecord,
        // Replacement values for the unused lead fields.
        arbEdgeString,
        arbEdgeString,
        arbEdgeString,
        fc.integer({ min: 0, max: 4102444800000 }).map((ms) =>
          new Date(ms).toISOString(),
        ),
        arbLeadProfile,
        (lead, caseStudy, leadId, senderName, senderEmail, normalizedAt, other) => {
          const varied: LeadProfile = {
            ...lead,
            leadId,
            senderName,
            senderEmail,
            normalizedAt,
            // rawEmail is never read by the rubric — swap in an unrelated one.
            rawEmail: other.rawEmail,
          };

          expect(scoreCaseStudy(varied, caseStudy)).toStrictEqual(
            scoreCaseStudy(lead, caseStudy),
          );
        },
      ),
    );
  });

  it("ignores case-study fields the rubric never reads", () => {
    fc.assert(
      fc.property(
        arbLeadProfile,
        arbCaseStudyRecord,
        arbCaseStudyRecord,
        (lead, caseStudy, other) => {
          const varied: CaseStudyRecord = {
            ...caseStudy,
            // Provenance / bookkeeping fields not consumed by scoring.
            sourceUrl: other.sourceUrl,
            verificationStatus: other.verificationStatus,
            retrievedAt: other.retrievedAt,
            // `title` is likewise not part of any dimension comparison.
            title: other.title,
          };

          expect(scoreCaseStudy(lead, varied)).toStrictEqual(
            scoreCaseStudy(lead, caseStudy),
          );
        },
      ),
    );
  });
});
