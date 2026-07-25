/**
 * Property 6 — Known fields are grounded in the lead.
 *
 * **Validates: Requirements 3.3**
 *
 * A model-extracted known field survives only when BOTH grounding conditions
 * hold: its `sourceLeadField` names a lead field whose value is not `"unknown"`,
 * AND its `evidenceQuote` actually appears in the lead's text. This suite
 * asserts `filterGroundedKnownFields` enforces exactly that AND:
 *
 *   - A controlled construction proves the two failure modes are each fatal on
 *     their own: a field sourced from an `"unknown"` lead field is dropped even
 *     with a present quote, and a field with a quote absent from the lead is
 *     dropped even from a known source. Grounded fields are kept, in order.
 *   - An arbitrary-input check cross-validates the composed filter against the
 *     stage's own exported grounding predicates for every input.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { KnownField, LeadProfile } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import {
  buildLeadText,
  evidenceAppearsInLead,
  filterGroundedKnownFields,
  leadFieldIsKnown,
} from "@/agent/stages/stage-1-qualifier";

import { arbEdgeString, arbLeadProfile } from "./arbitraries";

/** A quote guaranteed never to appear in any generated lead text. */
const ABSENT_QUOTE = "\u2021SENTINEL_QUOTE_NOT_PRESENT\u2021";

/** Build a KnownField; slotId/value/label are irrelevant to grounding. */
function knownField(
  sourceLeadField: keyof LeadProfile,
  evidenceQuote: string,
): KnownField {
  return {
    slotId: "slot",
    slotLabel: "Slot",
    value: "v",
    sourceLeadField,
    evidenceQuote,
  };
}

describe("Property 6: known fields are grounded in the lead (Req 3.3)", () => {
  it("drops ungrounded fields and keeps grounded ones (both conditions required)", () => {
    fc.assert(
      fc.property(
        // Distinctive, collision-free hex tokens for two real lead fields.
        fc.integer({ min: 0, max: 0xffffffff }).map((n) => n.toString(16).padStart(8, "0")),
        fc.integer({ min: 0, max: 0xffffffff }).map((n) => n.toString(16).padStart(8, "0")),
        (companyHex, titleHex) => {
          const companyValue = `Company_${companyHex}`;
          const titleValue = `Title_${titleHex}`;

          // A lead with two KNOWN fields (company, title) and an UNKNOWN one.
          const lead: LeadProfile = {
            leadId: "lead_1",
            senderName: UNKNOWN,
            senderEmail: UNKNOWN,
            title: titleValue,
            division: UNKNOWN,
            company: companyValue,
            companyDomain: UNKNOWN,
            country: UNKNOWN,
            region: UNKNOWN,
            industry: UNKNOWN, // the unknown-source field under test
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
          };

          const groundedCompany = knownField("company", companyValue);
          const groundedTitle = knownField("title", titleValue);
          // Unknown source, but the quote IS present -> still dropped.
          const unknownSource = knownField("industry", companyValue);
          // Known source, but the quote is absent -> dropped.
          const absentQuote = knownField("company", ABSENT_QUOTE);

          const input = [groundedCompany, unknownSource, groundedTitle, absentQuote];
          const kept = filterGroundedKnownFields(input, lead);

          // Exactly the two grounded fields survive, in their original order.
          expect(kept).toEqual([groundedCompany, groundedTitle]);
        },
      ),
    );
  });

  it("equals the field set satisfying both exported grounding predicates, for arbitrary input", () => {
    const arbKnownField: fc.Arbitrary<KnownField> = fc.record({
      slotId: arbEdgeString,
      slotLabel: arbEdgeString,
      value: arbEdgeString,
      sourceLeadField: fc.constantFrom<keyof LeadProfile>(
        "company",
        "title",
        "industry",
        "country",
        "region",
        "statedUseCase",
        "referralSource",
      ),
      evidenceQuote: arbEdgeString,
    });

    fc.assert(
      fc.property(
        arbLeadProfile,
        fc.array(arbKnownField, { maxLength: 12 }),
        (lead, fields) => {
          const leadText = buildLeadText(lead);
          const kept = filterGroundedKnownFields(fields, lead);

          for (const field of fields) {
            const grounded =
              leadFieldIsKnown(lead, field.sourceLeadField) &&
              evidenceAppearsInLead(leadText, field.evidenceQuote);
            expect(kept.includes(field)).toBe(grounded);
          }

          // Filter preserves input order and never invents fields.
          expect(kept).toEqual(
            fields.filter(
              (f) =>
                leadFieldIsKnown(lead, f.sourceLeadField) &&
                evidenceAppearsInLead(leadText, f.evidenceQuote),
            ),
          );
        },
      ),
    );
  });
});
