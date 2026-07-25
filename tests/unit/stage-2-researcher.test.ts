/**
 * Unit tests — Stage 2 dimension content and total search failure
 * (Task 8.6, Req 4.2–4.5, 17.3).
 *
 * Two scenarios exercise `stage2Researcher.run` over the REAL toolbelt + REAL
 * ledger with only the network hops stubbed:
 *
 *   1. Dimension content (Req 4.2–4.5): each searched dimension surfaces its own
 *      stubbed page, so extraction produces a verified claim FOR THAT DIMENSION —
 *      an org-structure claim, a budget-signal claim, a recent-news claim, and a
 *      leadership-language claim.
 *   2. Total request failure (Req 17.3): search returns nothing and every fetch
 *      fails, so the stage degrades to ONLY `"unknown"` claims with a
 *      `verifiedClaimCount` of 0 and every dimension flagged with no source.
 *      (Run status is stamped by the orchestrator, not the stage.)
 */

import { describe, expect, it } from "vitest";

import type { ZodType } from "zod";
import { UNKNOWN, type ResearchDimension } from "@/agent/contracts";
import {
  SEARCHED_DIMENSIONS,
  buildAllDimensionQueries,
  stage2Researcher,
  type SearchedDimension,
} from "@/agent/stages/stage-2-researcher";
import { createStage2Harness, makeLeadProfile } from "@tests/support/stage2-harness";

/** Per-dimension stubbed source: URL, page text, a quote within it, and a claim. */
const DIMENSION_SOURCES: Record<
  SearchedDimension,
  { url: string; text: string; quote: string; claimText: string }
> = {
  org_structure: {
    url: "https://acme.example.com/org",
    text: "The Chief Operations Officer leads mining operations and its reporting lines.",
    quote: "reporting lines",
    claimText: "Org structure: the COO leads mining operations.",
  },
  budget_signals: {
    url: "https://acme.example.com/budget",
    text: "Capital expenditure reached record levels in the latest annual report.",
    quote: "Capital expenditure",
    claimText: "Budget: record capital expenditure this year.",
  },
  recent_news: {
    url: "https://acme.example.com/news",
    text: "The company announced a new automation and safety initiative for its sites.",
    quote: "automation and safety",
    claimText: "News: launched an automation and safety initiative.",
  },
  leadership_language: {
    url: "https://acme.example.com/leadership",
    text: "In the shareholder letter the CEO emphasized operational priorities and efficiency.",
    quote: "operational priorities",
    claimText: "Leadership: CEO emphasized operational priorities.",
  },
};

describe("Stage 2 Researcher — dimension content (Req 4.2–4.5)", () => {
  it("produces a verified claim for each dimension from its retrieved page", async () => {
    const lead = makeLeadProfile();
    const queriesByDimension = buildAllDimensionQueries(lead);

    // Route each dimension's queries to that dimension's stubbed source URL.
    const queryToDimension = new Map<string, SearchedDimension>();
    for (const dimension of SEARCHED_DIMENSIONS) {
      for (const query of queriesByDimension[dimension]) {
        queryToDimension.set(query, dimension);
      }
    }

    const pages = Object.fromEntries(
      SEARCHED_DIMENSIONS.map((d) => [
        DIMENSION_SOURCES[d].url,
        { text: DIMENSION_SOURCES[d].text, contentType: "text/plain" as const },
      ]),
    );

    // Extraction (one call per dimension) cites that dimension's URL + quote.
    const llm = (args: { purpose: string; schema: ZodType }): unknown => {
      const match = /^stage-2-extract-(.+)$/.exec(args.purpose);
      if (match) {
        const dimension = match[1] as SearchedDimension;
        const source = DIMENSION_SOURCES[dimension];
        return {
          claims: [
            {
              claimText: source.claimText,
              sourceUrl: source.url,
              supportingQuote: source.quote,
              numericFigures: [],
            },
          ],
        };
      }
      if (args.purpose === "stage-2-positioning") {
        return { narrative: UNKNOWN, assertions: [] };
      }
      return args.schema.parse(undefined);
    };

    const { ctx } = createStage2Harness({
      lead,
      search: (query) => {
        const dimension = queryToDimension.get(query);
        if (!dimension) return [];
        return [
          {
            url: DIMENSION_SOURCES[dimension].url,
            title: `${dimension} source`,
            snippet: null,
            publishedDate: null,
          },
        ];
      },
      pages,
      llm: llm as never,
    });

    const report = await stage2Researcher.run(ctx);

    // Every dimension has exactly one verified, grounded claim.
    for (const dimension of SEARCHED_DIMENSIONS) {
      const claims = report.claims.filter((c) => c.dimension === dimension);
      expect(claims).toHaveLength(1);

      const claim = claims[0]!;
      expect(claim.verificationStatus).toBe("verified");
      expect(claim.claimText).toBe(DIMENSION_SOURCES[dimension].claimText);
      expect(claim.sourceUrl).toBe(DIMENSION_SOURCES[dimension].url);
      expect(claim.supportingQuote).toBe(DIMENSION_SOURCES[dimension].quote);
      // retrievedAt is stamped from the ledger-backed page, never "unknown".
      expect(claim.retrievedAt).not.toBe(UNKNOWN);

      expect(report.claimsByDimension[dimension]).toEqual([claim.claimId]);
    }

    expect(report.verifiedClaimCount).toBe(SEARCHED_DIMENSIONS.length);
    expect(report.dimensionsWithNoSource).toHaveLength(0);
  });
});

describe("Stage 2 Researcher — total request failure (Req 17.3)", () => {
  it("yields only unknown claims and verifiedClaimCount 0 when every request fails", async () => {
    // Search returns []; no pages are mapped so every fetch degrades to null.
    const { ctx } = createStage2Harness({ search: [] });

    const report = await stage2Researcher.run(ctx);

    // Only "unknown" claims — nothing fabricated without a source.
    expect(report.claims.length).toBe(SEARCHED_DIMENSIONS.length);
    for (const claim of report.claims) {
      expect(claim.claimText).toBe(UNKNOWN);
      expect(claim.verificationStatus).toBe("unknown");
      expect(claim.sourceUrl).toBe(UNKNOWN);
    }

    // Every searched dimension is flagged with no source.
    const flagged = new Set<ResearchDimension>(report.dimensionsWithNoSource);
    for (const dimension of SEARCHED_DIMENSIONS) {
      expect(flagged.has(dimension)).toBe(true);
    }

    // No verified claims; positioning carries no assertions.
    expect(report.verifiedClaimCount).toBe(0);
    expect(report.positioningRecommendation.assertions).toHaveLength(0);
  });
});
