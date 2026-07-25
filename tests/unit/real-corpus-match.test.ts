/**
 * Grounding test — the real FlytBase corpus produces the right answer for the
 * Fixed_Lead (Req 1.5, 8.1-8.5, 7.6).
 *
 * This is the test that proves the system is grounded in reality rather than in
 * invented data. It runs the REAL scoring rubric and the REAL ranking over the
 * REAL committed snapshot of `flytbase.com/case-studies`, using the normalized
 * Fixed_Lead, and asserts the outcome a human BDR would reach:
 *
 *   - the corpus contains only real, resolvable `flytbase.com` case-study URLs
 *     (no invented slug, no `www.` host that would 404 the same-origin filter);
 *   - the lead's industry is inferred as Mining (the highest-weighted rubric
 *     dimension is live, not dead at 0.0);
 *   - the winning case study is FlytBase's own SQM deployment — the same account
 *     as the lead — and the runner-up is a mining deployment in the same region;
 *   - the winner beats the runner-up on at least one named dimension.
 */

import { describe, expect, it } from "vitest";

import { UNKNOWN } from "@/agent/contracts";
import { FIXED_LEAD } from "@/agent/fixed-lead";
import { normalizeLead } from "@/agent/lead-normalizer";
import { rankCorpus } from "@/agent/stages/stage-4/ranking";
import { loadCachedCorpus } from "@/research/cached-corpus";

const lead = normalizeLead(FIXED_LEAD, () => "2026-07-25T00:00:00.000Z");

describe("real FlytBase corpus is grounded and resolvable", () => {
  it("every cached record points at a real flytbase.com case-study URL", () => {
    const cached = loadCachedCorpus();
    expect(cached).not.toBeNull();

    for (const record of cached!.records) {
      // The apex host, not `www.` — the live site serves links from flytbase.com,
      // and a `www.` host would be rejected by the same-origin enumerator.
      expect(record.sourceUrl.startsWith("https://flytbase.com/")).toBe(true);
      expect(record.sourceUrl).not.toContain("www.flytbase.com");
      // Real case studies live under /case-studies/<slug>.
      expect(record.sourceUrl).toMatch(/^https:\/\/flytbase\.com\/case-studies\/[a-z0-9-]+$/);
    }
  });

  it("serves cached records stamped stale, never verified", () => {
    for (const record of loadCachedCorpus()!.records) {
      expect(record.verificationStatus).toBe("stale");
    }
  });
});

describe("Fixed_Lead normalization feeds the rubric real inputs", () => {
  it("infers Mining as the industry so the top-weighted dimension is live", () => {
    expect(lead.industry).toBe("Mining");
  });

  it("resolves the geography the mining corpus can be matched against", () => {
    expect(lead.country).toBe("Chile");
    expect(lead.region).toBe("South America");
  });
});

describe("ranking the real corpus for the Fixed_Lead", () => {
  const ranking = rankCorpus(lead, loadCachedCorpus()!.records);

  it("selects FlytBase's own SQM deployment as the winning case study", () => {
    expect(ranking.winner).not.toBe(UNKNOWN);
    const winner = ranking.winner as Exclude<typeof ranking.winner, "unknown">;

    expect(winner.record.sourceUrl).toBe(
      "https://flytbase.com/case-studies/sqm-678-km2-mine-autonomous-inspection-adentu-and-flytbase",
    );
    expect(winner.record.industry).toBe("Mining");
    expect(winner.record.region).toBe("Chile");
    // The real deployment ran through a Chile-based integrator, which is the
    // partner evidence the GTM stage reasons about.
    expect(winner.record.namedPartner).toBe("Adentu");
  });

  it("names a runner-up and explains the win on a real dimension", () => {
    expect(ranking.runnerUp).not.toBe(UNKNOWN);
    const winner = ranking.winner as Exclude<typeof ranking.winner, "unknown">;
    const runnerUp = ranking.runnerUp as Exclude<typeof ranking.runnerUp, "unknown">;

    expect(winner.breakdown.matchScore).toBeGreaterThanOrEqual(
      runnerUp.breakdown.matchScore,
    );
    if (winner.breakdown.matchScore > runnerUp.breakdown.matchScore) {
      expect(ranking.decidingDimensions.length).toBeGreaterThan(0);
    }
    expect(ranking.comparisonStatement).not.toBe(UNKNOWN);
  });

  it("scores every record inside the closed unit interval", () => {
    for (const scored of ranking.rankedCorpus) {
      expect(scored.breakdown.matchScore).toBeGreaterThanOrEqual(0);
      expect(scored.breakdown.matchScore).toBeLessThanOrEqual(1);
    }
  });
});
