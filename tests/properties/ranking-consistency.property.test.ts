/**
 * Property 23: Ranking is consistent and lossless.
 *
 * For any case-study corpus — including empty and single-record corpora, and
 * records whose fields are `"unknown"`, empty, unicode, or very long — the
 * ranked output:
 *
 *   1. is lossless: every input record appears in `rankedCorpus` exactly once
 *      (the multiset of records going in equals the multiset coming out, with
 *      no drops, duplicates, or fabricated entries);
 *   2. is consistently ordered: `rankedCorpus` runs in non-increasing
 *      `matchScore` order with 1-based ranks 1..n assigned contiguously in
 *      that order (Req 8.4);
 *   3. names the right winner and runner-up: `winner` is the rank-1 entry (or
 *      `"unknown"` for an empty corpus) and `runnerUp` is the rank-2 entry, or
 *      `"unknown"` when the corpus holds fewer than two records (Req 8.9); and
 *   4. explains a strict win: whenever the winner's `matchScore` strictly
 *      exceeds the runner-up's, `decidingDimensions` is non-empty and every
 *      dimension it names has a strictly greater weighted contribution for the
 *      winner than for the runner-up (Req 8.5).
 *
 * Validates: Requirements 8.3, 8.4, 8.5, 8.9
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MIN_CORPUS_FOR_RUNNER_UP,
  rankCorpus,
} from "@/agent/stages/stage-4/ranking";
import type {
  CaseStudyRecord,
  RubricDimension,
  ScoredCaseStudy,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";

import { arbCaseStudyRecord, arbLeadProfile } from "./arbitraries";

/**
 * A reference-identity multiset of records. Each ranked entry re-exposes the
 * exact input record object, so counting by identity proves losslessness even
 * when two generated records are structurally equal.
 */
function identityCounts(records: readonly CaseStudyRecord[]): Map<CaseStudyRecord, number> {
  const counts = new Map<CaseStudyRecord, number>();
  for (const record of records) {
    counts.set(record, (counts.get(record) ?? 0) + 1);
  }
  return counts;
}

/** The weighted contribution the winner/runner-up earned on one dimension. */
function contributionOf(scored: ScoredCaseStudy, dimension: RubricDimension): number {
  const dim = scored.breakdown.dimensions.find((d) => d.dimension === dimension);
  return dim ? dim.contribution : 0;
}

describe("Property 23: ranking is consistent and lossless", () => {
  it("holds for any lead profile and corpus (including empty and single-record)", () => {
    fc.assert(
      fc.property(
        arbLeadProfile,
        fc.array(arbCaseStudyRecord, { maxLength: 10 }),
        (lead, corpus) => {
          const result = rankCorpus(lead, corpus);

          // corpusSize reflects the input length exactly.
          expect(result.corpusSize).toBe(corpus.length);
          expect(result.rankedCorpus).toHaveLength(corpus.length);

          // (1) Lossless: the multiset of input record references equals the
          // multiset of ranked record references — no drops, no duplicates,
          // no fabricated records.
          const inputCounts = identityCounts(corpus);
          const outputCounts = identityCounts(
            result.rankedCorpus.map((entry) => entry.record),
          );
          expect(outputCounts.size).toBe(inputCounts.size);
          for (const [record, count] of inputCounts) {
            expect(outputCounts.get(record)).toBe(count);
          }

          // (2) Consistent ordering: non-increasing matchScore and contiguous
          // 1-based ranks in that order (Req 8.4).
          for (let i = 0; i < result.rankedCorpus.length; i += 1) {
            const current = result.rankedCorpus[i];
            const prev = result.rankedCorpus[i - 1];
            expect(current?.rank).toBe(i + 1);
            if (i > 0 && current && prev) {
              expect(prev.breakdown.matchScore).toBeGreaterThanOrEqual(
                current.breakdown.matchScore,
              );
            }
          }

          // (3) Winner and runner-up selection (Req 8.9).
          if (corpus.length === 0) {
            expect(result.winner).toBe(UNKNOWN);
          } else {
            expect(result.winner).toBe(result.rankedCorpus[0]);
          }

          if (corpus.length < MIN_CORPUS_FOR_RUNNER_UP) {
            expect(result.runnerUp).toBe(UNKNOWN);
          } else {
            expect(result.runnerUp).toBe(result.rankedCorpus[1]);
          }

          expect(result.corpusUnderfilled).toBe(corpus.length < MIN_CORPUS_FOR_RUNNER_UP);

          // (4) A strict win is explained (Req 8.5). Only meaningful when both
          // a winner and a runner-up exist.
          if (result.winner !== UNKNOWN && result.runnerUp !== UNKNOWN) {
            const winner = result.winner;
            const runnerUp = result.runnerUp;

            if (winner.breakdown.matchScore > runnerUp.breakdown.matchScore) {
              expect(result.decidingDimensions.length).toBeGreaterThan(0);
              for (const dimension of result.decidingDimensions) {
                expect(contributionOf(winner, dimension)).toBeGreaterThan(
                  contributionOf(runnerUp, dimension),
                );
              }
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
