/**
 * Property 24: Scoring is sensitive to lead industry and geography (Req 8.7).
 *
 * Feature: inbound-bdr-agent, Property 24: For any pair of lead profiles whose
 * normalized industry buckets differ or whose normalized region buckets differ,
 * scored against a shared corpus containing at least one record with a
 * non-"unknown" industry and a non-"unknown" region, the two score breakdowns
 * differ in at least one dimension contribution.
 *
 * The rubric can only "see" a difference when the varied values live inside its
 * generic reference tables (INDUSTRY_TAXONOMY and COUNTRY_TO_REGION). Two leads
 * that both carry "unknown" — or both carry an unrecognized token — score 0.0 in
 * the same way and are indistinguishable, which is by design, not a violation of
 * Req 8.7. So this test builds two leads that share every other field and differ
 * ONLY in industry, ONLY in geography, or in both, always choosing recognized,
 * distinguishable values. fast-check varies which recognized industry and which
 * recognized country are used across every run, exercising the taxonomy and the
 * country→region table broadly. The shared case study always carries a
 * recognized (non-"unknown") industry and region, satisfying the corpus
 * precondition.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";

import type { CaseStudyRecord, DimensionScore, LeadProfile } from "@/agent/contracts";
import { scoreCaseStudy } from "@/agent/stages/stage-4/scoring-rubric";

import { arbCaseStudyRecord, arbLeadProfile } from "./arbitraries";

/**
 * Recognized industries whose taxonomy parent-bucket sets are pairwise disjoint
 * and whose surface tokens do not overlap. Picking two distinct entries from
 * this list guarantees the industry sub-score can distinguish them: an exact
 * match scores 1.0 while a disjoint-bucket industry scores 0.0.
 */
const DISTINCT_INDUSTRIES = [
  "mining",
  "agriculture",
  "government",
  "security",
  "utilities",
  "manufacturing",
] as const;

/**
 * One recognized country per macro-region bucket in COUNTRY_TO_REGION. Picking
 * two distinct entries guarantees the geography sub-score can distinguish them:
 * an exact region-string match scores 1.0 while a different region bucket scores
 * 0.0.
 */
const DISTINCT_REGION_COUNTRIES = [
  "chile", // south_america
  "canada", // north_america
  "germany", // europe
  "india", // asia
  "australia", // oceania
  "nigeria", // africa
  "qatar", // middle_east
] as const;

type Mode = "industry" | "geography" | "both";

interface SensitivityScenario {
  caseStudy: CaseStudyRecord;
  leadA: LeadProfile;
  leadB: LeadProfile;
  mode: Mode;
}

/** Pick two distinct indices [i, j] into a list of the given length. */
const arbDistinctPair = (length: number): fc.Arbitrary<[number, number]> =>
  fc
    .tuple(fc.integer({ min: 0, max: length - 1 }), fc.integer({ min: 1, max: length - 1 }))
    .map(([i, offset]) => [i, (i + offset) % length] as [number, number]);

/**
 * Builds a shared case study plus two leads that share every field except the
 * dimension(s) named by `mode`, where they take recognized, distinguishable
 * values. The case study's industry and region are always recognized so the
 * corpus precondition of Property 24 holds.
 */
const arbSensitivityScenario: fc.Arbitrary<SensitivityScenario> = fc
  .record({
    baseLead: arbLeadProfile,
    baseCaseStudy: arbCaseStudyRecord,
    mode: fc.constantFrom<Mode>("industry", "geography", "both"),
    industryPair: arbDistinctPair(DISTINCT_INDUSTRIES.length),
    countryPair: arbDistinctPair(DISTINCT_REGION_COUNTRIES.length),
  })
  .map(({ baseLead, baseCaseStudy, mode, industryPair, countryPair }) => {
    const [iA, iB] = industryPair;
    const [cA, cB] = countryPair;
    const industryA = DISTINCT_INDUSTRIES[iA] ?? "Mining";
    const industryB = DISTINCT_INDUSTRIES[iB] ?? "Metals";
    const countryA = DISTINCT_REGION_COUNTRIES[cA] ?? "Chile";
    const countryB = DISTINCT_REGION_COUNTRIES[cB] ?? "Germany";

    // The shared corpus record carries recognized industry + region so it can
    // distinguish the leads and satisfies the "non-unknown" precondition.
    const caseStudy: CaseStudyRecord = {
      ...baseCaseStudy,
      industry: industryA,
      region: countryA,
    };

    // Both leads start identical (so useCase and partnerOverlap contributions
    // are guaranteed equal), then differ only in the dimension(s) under test.
    const leadIndustryB = mode === "geography" ? industryA : industryB;
    const leadCountryB = mode === "industry" ? countryA : countryB;

    const leadA: LeadProfile = {
      ...baseLead,
      industry: industryA,
      country: countryA,
    };
    const leadB: LeadProfile = {
      ...baseLead,
      industry: leadIndustryB,
      country: leadCountryB,
    };

    return { caseStudy, leadA, leadB, mode };
  });

/** True when some dimension's weighted contribution differs beyond FP noise. */
function contributionsDiffer(a: DimensionScore[], b: DimensionScore[]): boolean {
  const byDimension = new Map(b.map((d) => [d.dimension, d.contribution]));
  return a.some((d) => {
    const other = byDimension.get(d.dimension);
    return other === undefined || Math.abs(d.contribution - other) > 1e-9;
  });
}

describe("scoring attribute sensitivity (Property 24)", () => {
  // Validates: Requirements 8.7
  test("leads differing in industry or geography yield breakdowns differing in a dimension contribution", () => {
    fc.assert(
      fc.property(arbSensitivityScenario, ({ caseStudy, leadA, leadB }) => {
        const breakdownA = scoreCaseStudy(leadA, caseStudy);
        const breakdownB = scoreCaseStudy(leadB, caseStudy);
        expect(contributionsDiffer(breakdownA.dimensions, breakdownB.dimensions)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test("the case study corpus record always carries a non-unknown industry and region", () => {
    fc.assert(
      fc.property(arbSensitivityScenario, ({ caseStudy }) => {
        expect(caseStudy.industry).not.toBe("unknown");
        expect(caseStudy.region).not.toBe("unknown");
      }),
      { numRuns: 100 },
    );
  });
});
