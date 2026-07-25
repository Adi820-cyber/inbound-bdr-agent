/**
 * Property 27 — The GTM decision is invariant to names.
 *
 * **Validates: Requirements 9.6**
 *
 * Req 9.6 forbids the GTM decision from branching on any company, person, or
 * referral-organization name: two runs that differ only in those names must
 * produce an identical motion, complexity score, and partner type. The pure
 * `GtmDecisionInputs` interface carries no name fields at all, so this suite
 * demonstrates the invariant by showing the decision depends ONLY on the typed
 * signals and the vocabulary hits in the retrieved partner text:
 *
 *   - `partnerNames` is an audit-only field the decision never reads, so
 *     changing it changes nothing.
 *   - Surrounding name-like tokens in `partnerTypeHints` that contain NO
 *     vocabulary terms can be swapped, reordered, added, or removed without
 *     altering `classifyPartnerType`, because classification counts only
 *     generic-vocabulary occurrences.
 *
 * Both variants keep the SAME vocabulary hits and the SAME typed signals; only
 * the name-like tokens vary. The decision tuple must be identical across them.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN } from "@/agent/contracts";
import {
  classifyPartnerType,
  decideGtmMotion,
  type GtmComplexitySignals,
  type GtmDecisionInputs,
} from "@/agent/stages/stage-5/gtm-decision";

/**
 * Generic partner-page vocabulary the classifier scores against — the ONLY
 * tokens that legitimately influence the partner type.
 */
const VOCAB_TERMS: readonly string[] = [
  "integration",
  "deployment",
  "end-to-end",
  "si",
  "drone-as-a-service",
  "flight operations",
  "pilot services",
  "reseller",
  "distributor",
  "authorized dealer",
  "automation consulting",
  "industrial iot advisory",
];

/**
 * Name-like tokens (companies, people, referral orgs). Every entry is verified
 * to contain NO bounded vocabulary term, so injecting them cannot change the
 * classifier's hit counts — they stand in for the arbitrary names Req 9.6 says
 * the decision must ignore.
 */
const NAME_TOKENS: readonly string[] = [
  "Rodrigo Castillo",
  "Anglo American",
  "Acme Holdings",
  "Zenith Group",
  "Globex Corporation",
  "Initech",
  "Umbrella Ventures",
  "Wonka Enterprises",
  "Stark Industrial Group",
  "Wayne Mining Co",
  "Contoso Ltd",
  "Fabrikam",
  "Northwind Traders",
];

const arbNameTokens: fc.Arbitrary<string[]> = fc.array(
  fc.constantFrom(...NAME_TOKENS),
  { maxLength: 6 },
);

/** Shared vocabulary hits — identical between the two variants. */
const arbVocabHits: fc.Arbitrary<string[]> = fc.array(
  fc.constantFrom(...VOCAB_TERMS),
  { maxLength: 8 },
);

const arbSignals: fc.Arbitrary<GtmComplexitySignals> = fc.record({
  siteCount: fc.oneof(fc.integer({ min: 0, max: 12 }), fc.constant(UNKNOWN)),
  continuousOperations: fc.boolean(),
  regulatedEnvironment: fc.boolean(),
  multiStakeholder: fc.boolean(),
  dealSizeIndicator: fc.oneof(
    fc.constantFrom("small" as const, "mid" as const, "large" as const),
    fc.constant(UNKNOWN),
  ),
});

describe("Property 27: the GTM decision is invariant to names (Req 9.6)", () => {
  it("classifyPartnerType is unchanged when only name-like tokens vary", () => {
    fc.assert(
      fc.property(
        arbVocabHits,
        arbNameTokens,
        arbNameTokens,
        (vocabHits, namesA, namesB) => {
          // Same vocabulary hits, different surrounding names and ordering.
          const hintsA = [...namesA, ...vocabHits];
          const hintsB = [...vocabHits, ...namesB];

          expect(classifyPartnerType(hintsA)).toBe(classifyPartnerType(hintsB));
        },
      ),
    );
  });

  it("decideGtmMotion output is invariant under changing names (partnerNames + name-like hint tokens)", () => {
    fc.assert(
      fc.property(
        arbSignals,
        fc.boolean(), // partner evidence found
        fc.boolean(), // headquarters region
        arbVocabHits,
        arbNameTokens,
        arbNameTokens,
        (signals, found, isHeadquartersRegion, vocabHits, namesA, namesB) => {
          const base = {
            leadCountry: UNKNOWN,
            leadRegion: UNKNOWN,
            isHeadquartersRegion,
            complexitySignals: signals,
          };

          // Variant A and B share vocab hits + typed signals, and differ ONLY in
          // the audit-only partnerNames and the name-like tokens in the hints.
          const inputsA: GtmDecisionInputs = {
            ...base,
            partnerEvidence: {
              found,
              partnerNames: namesA,
              partnerTypeHints: [...namesA, ...vocabHits],
              sourceUrl: UNKNOWN,
            },
          };
          const inputsB: GtmDecisionInputs = {
            ...base,
            partnerEvidence: {
              found,
              partnerNames: namesB,
              partnerTypeHints: [...vocabHits, ...namesB],
              sourceUrl: UNKNOWN,
            },
          };

          const a = decideGtmMotion(inputsA);
          const b = decideGtmMotion(inputsB);

          expect(a.motion).toBe(b.motion);
          expect(a.complexity.complexityScore).toBe(b.complexity.complexityScore);
          expect(a.partnerType).toBe(b.partnerType);
          expect(a.derivedWithoutPartnerEvidence).toBe(b.derivedWithoutPartnerEvidence);
        },
      ),
    );
  });
});
