/**
 * Property 25 — Every GTM run queries FlytBase partner material.
 *
 * **Validates: Requirements 9.1**
 *
 * Stage 5 must always reach out to FlytBase public material for partner-
 * ecosystem signals, and that outreach must be tied to the lead's geography so
 * a partner recommendation is regional rather than generic. This suite drives
 * the REAL `stage5GtmAdvisor.run` through the REAL Research Toolbelt (with only
 * a recording stub search provider and a stubbed clock/sleep injected), then
 * asserts that:
 *
 *   - at least one toolbelt search is issued, and
 *   - at least one issued query targets FlytBase public material (`flytbase.com`)
 *     with partner-ecosystem terms AND interpolates the lead's geography — the
 *     lead's country appears verbatim in that query.
 *
 * The search provider returns no hits, so no page fetch is attempted and the
 * decision degrades to `direct_ae`; the subject under test here is only the
 * queries the stage issues, captured on the stub's `calls` log.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { LeadProfile, RawEmailRecord, StageContext } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { stage5GtmAdvisor } from "@/agent/stages/stage-5-gtm-advisor";
import { createFetchLedger } from "@/research/fetch-ledger";
import { createResearchToolbelt } from "@/research/toolbelt";
import {
  createStubLlmProvider,
  createStubSearchProvider,
  type StubSearchProvider,
} from "@tests/support/stub-llm";

// ---------------------------------------------------------------------------
// Geography generators — realistic country/region tokens that are guaranteed to
// be "known" (non-empty, not the "unknown" marker) so the stage interpolates
// them into the query.
// ---------------------------------------------------------------------------

const arbCountry: fc.Arbitrary<string> = fc.constantFrom(
  "Chile",
  "Brazil",
  "Germany",
  "Australia",
  "Canada",
  "Japan",
  "India",
  "United Kingdom",
  "France",
  "Mexico",
  "South Africa",
  "Norway",
);

const arbRegion: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    "south america",
    "europe",
    "asia",
    "north america",
    "oceania",
    "africa",
  ),
  fc.constant(UNKNOWN),
);

/** A minimal lead carrying only the geography under test; everything else unknown. */
function makeLead(country: string, region: string): LeadProfile {
  const rawEmail: RawEmailRecord = {
    fromName: "Example Sender",
    fromEmail: "sender@example.com",
    subject: "Inbound inquiry",
    body: "We are exploring drone automation for our operations.",
  };
  return {
    leadId: "lead_prop25",
    senderName: UNKNOWN,
    senderEmail: UNKNOWN,
    title: UNKNOWN,
    division: UNKNOWN,
    company: UNKNOWN,
    companyDomain: UNKNOWN,
    country,
    region,
    industry: UNKNOWN,
    statedUseCase: UNKNOWN,
    statedPainPoints: [],
    referralSource: UNKNOWN,
    statedTimeline: UNKNOWN,
    siteCount: UNKNOWN,
    rawEmail,
    normalizedAt: "2024-01-01T00:00:00.000Z",
  };
}

/** Build a StageContext wired to the real toolbelt around a recording search stub. */
function makeContext(lead: LeadProfile, searchProvider: StubSearchProvider): StageContext {
  const ledger = createFetchLedger("run_prop25");
  const toolbelt = createResearchToolbelt({
    searchProvider,
    ledger,
    emit: () => {},
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    sleep: async () => {},
    requestTimeoutMs: 1000,
    maxPageFetchesPerRun: 5,
    politenessDelayMs: 0,
    textCharBudget: 100_000,
  });

  return {
    runId: "run_prop25",
    leadProfile: lead,
    toolbelt,
    llm: createStubLlmProvider(),
    emit: () => {},
    attempt: 1,
    upstream: {},
  };
}

describe("Property 25: every GTM run queries FlytBase partner material (Req 9.1)", () => {
  it("issues >=1 toolbelt search, and a FlytBase partner query interpolates the lead geography", async () => {
    await fc.assert(
      fc.asyncProperty(arbCountry, arbRegion, async (country, region) => {
        const searchProvider = createStubSearchProvider(); // returns [] but records calls
        const lead = makeLead(country, region);

        await stage5GtmAdvisor.run(makeContext(lead, searchProvider));

        // At least one toolbelt search was issued (Req 9.1).
        expect(searchProvider.calls.length).toBeGreaterThanOrEqual(1);

        // At least one query targets FlytBase public material with partner terms
        // AND interpolates the lead's geography (its country appears verbatim).
        const partnerMaterialGeoQuery = searchProvider.calls.find((call) => {
          const q = call.query;
          const lower = q.toLowerCase();
          return (
            lower.includes("flytbase.com") &&
            /partner/i.test(q) &&
            q.includes(country)
          );
        });
        expect(partnerMaterialGeoQuery).toBeDefined();
      }),
    );
  });
});
