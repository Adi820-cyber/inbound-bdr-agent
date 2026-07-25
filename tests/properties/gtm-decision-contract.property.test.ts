/**
 * Property 26 — The GTM decision satisfies its conditional contract.
 *
 * **Validates: Requirements 9.2, 9.3, 9.4, 9.5**
 *
 * `decideGtmMotion` is the pure decision core. For arbitrary typed inputs this
 * suite pins down its full conditional contract:
 *
 *   - `motion` is always one of `direct_ae` | `partner_led` (Req 9.2).
 *   - `partner_led` holds if and only if partner evidence was found AND the lead
 *     is NOT in a vendor direct-coverage (headquarters) region; `direct_ae`
 *     holds otherwise (Req 9.2).
 *   - `derivedWithoutPartnerEvidence` equals `!partnerEvidence.found` (Req 9.5).
 *   - `partnerType` is exactly `"unknown"` for a `direct_ae` motion, and a valid
 *     `PartnerType` value (which may be `"unknown"` on a tie or zero vocabulary
 *     hits) for a `partner_led` motion (Req 9.4).
 *
 * NOTE: the shared `arbGtmDecisionInputs` in `./arbitraries` models a DIFFERENT
 * shape (motion/geographyConsidered/signals/regionalPartnerEvidence) than the
 * decision function's actual `GtmDecisionInputs` interface. This suite builds
 * inputs matching the real interface in `stage-5/gtm-decision.ts`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN } from "@/agent/contracts";
import {
  decideGtmMotion,
  type GtmComplexitySignals,
  type GtmDecisionInputs,
  type GtmPartnerEvidenceInput,
} from "@/agent/stages/stage-5/gtm-decision";

/** The full set of legal `PartnerType` values, including the `"unknown"` marker. */
const VALID_PARTNER_TYPES: readonly string[] = [
  "systems_integrator",
  "drone_service_provider",
  "hardware_reseller",
  "industrial_automation_consultancy",
  "unknown",
];

/** Generic partner-page vocabulary the classifier scores against. */
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

const arbMaybeString: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constant(UNKNOWN),
  fc.constant(""),
);

const arbSignals: fc.Arbitrary<GtmComplexitySignals> = fc.record({
  siteCount: fc.oneof(
    fc.integer({ min: 0, max: 12 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.constant(UNKNOWN),
  ),
  continuousOperations: fc.boolean(),
  regulatedEnvironment: fc.boolean(),
  multiStakeholder: fc.boolean(),
  dealSizeIndicator: fc.oneof(
    fc.constantFrom("small" as const, "mid" as const, "large" as const),
    fc.constant(UNKNOWN),
  ),
});

/** A hint span: free text, or a vocabulary-bearing term, so classification varies. */
const arbHint: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constantFrom(...VOCAB_TERMS),
);

const arbPartnerEvidence: fc.Arbitrary<GtmPartnerEvidenceInput> = fc.record({
  found: fc.boolean(),
  partnerNames: fc.array(fc.string()),
  partnerTypeHints: fc.array(arbHint),
  sourceUrl: arbMaybeString,
});

const arbInputs: fc.Arbitrary<GtmDecisionInputs> = fc.record({
  leadCountry: arbMaybeString,
  leadRegion: arbMaybeString,
  isHeadquartersRegion: fc.boolean(),
  complexitySignals: arbSignals,
  partnerEvidence: arbPartnerEvidence,
});

describe("Property 26: the GTM decision satisfies its conditional contract (Req 9.2, 9.3, 9.4, 9.5)", () => {
  it("motion, partner-evidence coupling, derived flag, and partnerType all hold", async () => {
    await fc.assert(
      fc.asyncProperty(arbInputs, async (inputs) => {
        const decision = decideGtmMotion(inputs);

        // Motion is always one of the two legal values (Req 9.2).
        expect(["direct_ae", "partner_led"]).toContain(decision.motion);

        // partner_led IFF evidence found AND not a headquarters region (Req 9.2).
        const expectPartnerLed =
          inputs.partnerEvidence.found && !inputs.isHeadquartersRegion;
        expect(decision.motion).toBe(expectPartnerLed ? "partner_led" : "direct_ae");

        if (decision.motion === "partner_led") {
          expect(inputs.partnerEvidence.found).toBe(true);
          expect(inputs.isHeadquartersRegion).toBe(false);
        }

        // derivedWithoutPartnerEvidence === !found (Req 9.5).
        expect(decision.derivedWithoutPartnerEvidence).toBe(
          !inputs.partnerEvidence.found,
        );

        // partnerType: "unknown" for direct_ae; a valid PartnerType for partner_led (Req 9.4).
        if (decision.motion === "direct_ae") {
          expect(decision.partnerType).toBe(UNKNOWN);
        } else {
          expect(VALID_PARTNER_TYPES).toContain(decision.partnerType);
        }
      }),
    );
  });
});
