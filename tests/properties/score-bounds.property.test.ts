/**
 * Property 21: Match scores are bounded and equal their weighted sum.
 *
 * For any LeadProfile and any CaseStudyRecord — including records and profiles
 * whose fields are `"unknown"`, empty, unicode, or very long — every dimension
 * sub-score lies in the closed interval [0, 1], the breakdown contains exactly
 * one entry per rubric dimension, the `matchScore` lies in [0, 1], each
 * dimension `contribution` equals `weight * subScore`, and `matchScore` equals
 * the weighted sum of the sub-scores rounded to four decimals and re-clamped
 * (the exact arithmetic the implementation performs).
 *
 * Validates: Requirements 8.2, 8.6
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  RUBRIC_WEIGHTS,
  scoreCaseStudy,
} from "@/agent/stages/stage-4/scoring-rubric";
import type { RubricDimension } from "@/agent/contracts";

import { arbCaseStudyRecord, arbLeadProfile } from "./arbitraries";

/** The four rubric dimensions the breakdown must contain exactly once. */
const EXPECTED_DIMENSIONS: readonly RubricDimension[] = [
  "industry",
  "geography",
  "useCase",
  "partnerOverlap",
];

/** Mirror the implementation's clamp to the closed unit interval. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Mirror the implementation's four-decimal rounding. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

describe("Property 21: match scores are bounded and equal their weighted sum", () => {
  it("holds for any lead profile and case-study record", () => {
    fc.assert(
      fc.property(arbLeadProfile, arbCaseStudyRecord, (lead, caseStudy) => {
        const breakdown = scoreCaseStudy(lead, caseStudy);

        // Exactly one entry per rubric dimension, no extras, no omissions.
        expect(breakdown.dimensions).toHaveLength(EXPECTED_DIMENSIONS.length);
        const seen = breakdown.dimensions.map((d) => d.dimension).sort();
        expect(seen).toEqual([...EXPECTED_DIMENSIONS].sort());

        for (const dimension of breakdown.dimensions) {
          // Each sub-score is bounded to the closed unit interval.
          expect(dimension.subScore).toBeGreaterThanOrEqual(0);
          expect(dimension.subScore).toBeLessThanOrEqual(1);

          // Each dimension carries its published weight.
          expect(dimension.weight).toBe(RUBRIC_WEIGHTS[dimension.dimension]);

          // Contribution is exactly weight * subScore.
          expect(dimension.contribution).toBeCloseTo(
            dimension.weight * dimension.subScore,
            10,
          );
        }

        // matchScore is bounded to the closed unit interval (Req 8.6).
        expect(breakdown.matchScore).toBeGreaterThanOrEqual(0);
        expect(breakdown.matchScore).toBeLessThanOrEqual(1);

        // matchScore equals the weighted sum of sub-scores, rounded to four
        // decimals and re-clamped — the exact arithmetic the impl performs.
        const weightedSum = breakdown.dimensions.reduce(
          (acc, d) => acc + d.contribution,
          0,
        );
        expect(breakdown.matchScore).toBe(clamp01(round4(weightedSum)));
      }),
      { numRuns: 1000 },
    );
  });
});
