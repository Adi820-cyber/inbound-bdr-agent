/**
 * Unit tests for the lead normalizer's fixed-lead and alternative-email paths
 * (Task 3.4, Req 1.5, 1.6).
 *
 * Two guarantees are locked down here:
 *
 *   1. Fixed lead derivation (Req 1.5): normalizing the single hardcoded
 *      Fixed_Lead yields `referralSource === "Anglo American"` and a
 *      `statedTimeline` describing the Q3 internal budget conversation named in
 *      the body, plus the derived country/region (`Chile` / `South America`)
 *      and the verbatim-preserved raw email.
 *
 *   2. Alternative-email path (Req 1.6): an arbitrary alternative
 *      `RawEmailRecord` (different company, person, and country) normalizes
 *      through the exact same `normalizeLead` interface to a valid, total
 *      `LeadProfile` with its raw email preserved.
 */

import { describe, expect, it } from "vitest";

import { FIXED_LEAD } from "@/agent/fixed-lead";
import type { RawEmailRecord } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { normalizeLead } from "@/agent/lead-normalizer";
import { leadProfileSchema } from "@/agent/schemas";

// A fixed, injectable clock so `normalizedAt` is deterministic across runs.
const FIXED_NOW = "2025-01-15T12:00:00.000Z";
const now = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// 1. Fixed_Lead normalization (Req 1.5)
// ---------------------------------------------------------------------------

describe("normalizeLead — Fixed_Lead (Req 1.5)", () => {
  const profile = normalizeLead(FIXED_LEAD, now);

  it("derives the Anglo American referral source from the body", () => {
    expect(profile.referralSource).toBe("Anglo American");
  });

  it("captures the Q3 internal budget conversation as the stated timeline", () => {
    expect(profile.statedTimeline).not.toBe(UNKNOWN);
    const timeline = profile.statedTimeline as string;
    expect(timeline).toMatch(/Q3/);
    expect(timeline.toLowerCase()).toContain("budget");
    // The captured sentence names the internal budget conversation specifically.
    expect(timeline.toLowerCase()).toContain("internal budget conversation");
  });

  it("derives country Chile and region South America", () => {
    expect(profile.country).toBe("Chile");
    expect(profile.region).toBe("South America");
  });

  it("derives sender identity, company, and company domain", () => {
    expect(profile.senderName).toBe("Rodrigo Castillo");
    expect(profile.senderEmail).toBe("r.castillo@sqm.cl");
    expect(profile.company).toBe("Sociedad Quimica y Minera de Chile (SQM)");
    expect(profile.companyDomain).toBe("sqm.cl");
  });

  it("preserves the raw email verbatim and produces a valid LeadProfile", () => {
    expect(profile.rawEmail).toEqual(FIXED_LEAD);
    expect(profile.normalizedAt).toBe(FIXED_NOW);
    // The whole profile validates against the shared schema (total + lossless).
    expect(() => leadProfileSchema.parse(profile)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Arbitrary alternative raw email (Req 1.6)
// ---------------------------------------------------------------------------

describe("normalizeLead — arbitrary alternative raw email (Req 1.6)", () => {
  // A completely different lead: different person, company, country, use case.
  const ALT_LEAD: RawEmailRecord = {
    fromName: "Amara Okonkwo",
    fromEmail: "a.okonkwo@northwind-energy.co.uk",
    subject: "Drone-based tower inspection for our wind portfolio",
    body: [
      "Hi FlytBase team,",
      "",
      "I'm Amara Okonkwo, Director of Asset Management at Northwind Energy in the",
      "United Kingdom. We operate onshore wind farms and are exploring autonomous",
      "drone inspection to replace manual turbine tower climbs.",
      "",
      "A colleague referred me by Skyward Consulting after a project last year.",
      "We're hoping to move on this in the next quarter as budget frees up.",
      "",
      "Best,",
      "Amara Okonkwo",
    ].join("\n"),
    formFields: {
      name: "Amara Okonkwo",
      email: "a.okonkwo@northwind-energy.co.uk",
      title: "Director of Asset Management",
      company: "Northwind Energy",
      country: "United Kingdom",
    },
  };

  const profile = normalizeLead(ALT_LEAD, now);

  it("normalizes through the same interface to a valid LeadProfile", () => {
    // Same entry point, no fixed-lead-specific branching: the schema-valid
    // result proves the transform is total for an arbitrary record.
    expect(() => leadProfileSchema.parse(profile)).not.toThrow();
  });

  it("preserves the alternative raw email verbatim", () => {
    expect(profile.rawEmail).toEqual(ALT_LEAD);
  });

  it("derives the alternative lead's own identity and geography", () => {
    expect(profile.senderName).toBe("Amara Okonkwo");
    expect(profile.senderEmail).toBe("a.okonkwo@northwind-energy.co.uk");
    expect(profile.company).toBe("Northwind Energy");
    expect(profile.companyDomain).toBe("northwind-energy.co.uk");
    expect(profile.country).toBe("United Kingdom");
    expect(profile.region).toBe("Europe");
  });

  it("carries none of the Fixed_Lead's derived values", () => {
    expect(profile.referralSource).not.toBe("Anglo American");
    expect(profile.country).not.toBe("Chile");
    expect(profile.leadId).not.toBe(normalizeLead(FIXED_LEAD, now).leadId);
  });

  it("leaves un-derivable fields as the Unknown_Marker rather than inventing them", () => {
    // No numeric site count is stated in the alternative body.
    expect(profile.siteCount).toBe(UNKNOWN);
    // Industry is never deterministically derived from a raw email.
    expect(profile.industry).toBe(UNKNOWN);
  });
});
