/**
 * Property 7 — Priority score is bounded, explained, and band-consistent.
 *
 * **Validates: Requirements 3.5, 3.6, 3.7**
 *
 * The three deterministic post-processing guarantees of the score:
 *
 *   - Req 3.5: `clampPriorityScore` maps ANY number (including NaN, ±Infinity,
 *     negatives, and huge magnitudes) to an integer in the closed interval
 *     0..100; for a finite input it is `clamp(round(x), 0, 100)`, and a
 *     non-finite input becomes 0.
 *   - Req 3.7: `deriveFitAssessment` follows the score bands with no gaps or
 *     overlaps — `>=70` strong, `40..69` moderate, `<40` weak — so the label
 *     can never contradict the number.
 *   - Req 3.6: `ensureFactorsNamedInReasoning` returns reasoning that names
 *     every scoring factor, whether or not the model already mentioned it.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ScoreFactor } from "@/agent/contracts";
import {
  clampPriorityScore,
  deriveFitAssessment,
  ensureFactorsNamedInReasoning,
} from "@/agent/stages/stage-1-qualifier";

import { arbEdgeString } from "./arbitraries";

/** Any number, folding in the awkward magnitudes and non-finite values. */
const arbAnyNumber: fc.Arbitrary<number> = fc.oneof(
  fc.double(), // includes NaN and ±Infinity by default
  fc.double({ noNaN: true }),
  fc.integer(),
  fc.constantFrom(
    NaN,
    Infinity,
    -Infinity,
    0,
    -0,
    100,
    69.5,
    70,
    39.9,
    40,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ),
);

const arbScoreFactor: fc.Arbitrary<ScoreFactor> = fc.record({
  factor: arbEdgeString,
  contribution: fc.double({ noNaN: true, noDefaultInfinity: true }),
  explanation: arbEdgeString,
});

describe("Property 7: priority score is bounded, explained, and band-consistent (Req 3.5, 3.6, 3.7)", () => {
  it("clampPriorityScore returns an integer in 0..100 for any number (Req 3.5)", () => {
    fc.assert(
      fc.property(arbAnyNumber, (score) => {
        const clamped = clampPriorityScore(score);
        expect(Number.isInteger(clamped)).toBe(true);
        expect(clamped).toBeGreaterThanOrEqual(0);
        expect(clamped).toBeLessThanOrEqual(100);

        if (Number.isFinite(score)) {
          expect(clamped).toBe(Math.max(0, Math.min(100, Math.round(score))));
        } else {
          expect(clamped).toBe(0);
        }
      }),
    );
  });

  it("deriveFitAssessment is band-consistent with no gaps or overlaps (Req 3.7)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (score) => {
        const fit = deriveFitAssessment(score);
        if (score >= 70) expect(fit).toBe("strong_fit");
        else if (score >= 40) expect(fit).toBe("moderate_fit");
        else expect(fit).toBe("weak_fit");
      }),
    );
  });

  it("deriveFitAssessment agrees with the clamped score across any raw number", () => {
    fc.assert(
      fc.property(arbAnyNumber, (raw) => {
        const clamped = clampPriorityScore(raw);
        const fit = deriveFitAssessment(clamped);
        const expected =
          clamped >= 70 ? "strong_fit" : clamped >= 40 ? "moderate_fit" : "weak_fit";
        expect(fit).toBe(expected);
      }),
    );
  });

  it("ensureFactorsNamedInReasoning names every scoring factor (Req 3.6)", () => {
    fc.assert(
      fc.property(
        fc.array(arbScoreFactor, { maxLength: 10 }),
        arbEdgeString,
        (factors, reasoning) => {
          const out = ensureFactorsNamedInReasoning(factors, reasoning);
          for (const factor of factors) {
            expect(out.includes(factor.factor)).toBe(true);
          }
          // Whatever the model already wrote is preserved.
          expect(out.startsWith(reasoning)).toBe(true);
        },
      ),
    );
  });
});
