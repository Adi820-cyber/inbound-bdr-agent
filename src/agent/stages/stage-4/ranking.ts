/**
 * Stage 4 ranking and match-result assembly (Req 8.3, 8.4, 8.5, 8.9).
 *
 * A pure, deterministic layer on top of the scoring rubric. Given a lead and a
 * case-study corpus, it scores every record, orders the corpus by match score,
 * assigns 1-based ranks, and derives the winner, runner-up, the deciding
 * dimensions, and the human-readable comparison statement.
 *
 * The ranking obeys Property 23 ("ranking is consistent and lossless"):
 *  - Every input record appears in `rankedCorpus` exactly once (lossless).
 *  - Ranks run 1..n in non-increasing `matchScore` order.
 *  - `winner` is the rank-1 entry; `runnerUp` is the rank-2 entry, or the
 *    literal `"unknown"` when the corpus holds fewer than two records (Req 8.9).
 *  - Whenever the winner's score strictly exceeds the runner-up's,
 *    `decidingDimensions` is non-empty and every dimension it names has a
 *    strictly greater weighted contribution for the winner (Req 8.5).
 *
 * To keep results reproducible regardless of the order the extractor happened
 * to yield the corpus in, ties on `matchScore` are broken deterministically by
 * the record's `sourceUrl`. No LLM, no network, no ambient state.
 *
 * This module does not emit `StageEvent`s. When the corpus holds fewer than two
 * records the result carries `corpusSize` and the `corpusUnderfilled` flag so
 * the Stage 4 matcher module (task 12.3) can emit the corpus-size event.
 */

import type {
  CaseStudyRecord,
  DimensionScore,
  LeadProfile,
  Maybe,
  RubricDimension,
  ScoredCaseStudy,
} from "../../contracts";
import { UNKNOWN } from "../../contracts";
import { scoreCaseStudy } from "./scoring-rubric";

/** Number of records below which a runner-up cannot be named (Req 8.9). */
export const MIN_CORPUS_FOR_RUNNER_UP = 2;

/**
 * The pure product of ranking one corpus for one lead. The Stage 4 matcher
 * module composes this directly into a `MatchResult`, supplying the fields that
 * depend on provenance (`rubricWeights`, `corpusProvenance`, `cachedSnapshotAt`).
 */
export interface RankingResult {
  /** Number of records that were scored (the input corpus length). */
  corpusSize: number;
  /** Every input record, scored, ranked 1..n in non-increasing score order. */
  rankedCorpus: ScoredCaseStudy[];
  /** Rank-1 entry, or `"unknown"` when the corpus is empty. */
  winner: Maybe<ScoredCaseStudy>;
  /** Rank-2 entry, or `"unknown"` when the corpus holds fewer than two records (Req 8.9). */
  runnerUp: Maybe<ScoredCaseStudy>;
  /** Dimensions where the winner's contribution strictly exceeds the runner-up's. */
  decidingDimensions: RubricDimension[];
  /** Explanation of why the winner beat the runner-up, or `"unknown"` when undefined. */
  comparisonStatement: Maybe<string>;
  /** True when the corpus held fewer than two records — the matcher emits a StageEvent. */
  corpusUnderfilled: boolean;
}

/**
 * Score, rank, and assemble the match outcome for `corpus` against `lead`.
 *
 * Pure and total: for any corpus (including empty and single-record corpora)
 * this returns a fully populated `RankingResult`. Input records are never
 * dropped, duplicated, or mutated.
 */
export function rankCorpus(lead: LeadProfile, corpus: readonly CaseStudyRecord[]): RankingResult {
  const corpusSize = corpus.length;

  // Score every record. Preserve the original index so the tie-break stays
  // deterministic even when two records share a sourceUrl.
  const scored = corpus.map((record, index) => ({
    record,
    breakdown: scoreCaseStudy(lead, record),
    index,
  }));

  // Order by non-increasing match score. Ties break by sourceUrl, then by the
  // original position, so the ordering is a total, reproducible function of the
  // input set rather than of the order it arrived in.
  scored.sort((a, b) => {
    if (b.breakdown.matchScore !== a.breakdown.matchScore) {
      return b.breakdown.matchScore - a.breakdown.matchScore;
    }
    const urlCompare = a.record.sourceUrl.localeCompare(b.record.sourceUrl);
    if (urlCompare !== 0) return urlCompare;
    return a.index - b.index;
  });

  // Assign 1-based ranks in the sorted order.
  const rankedCorpus: ScoredCaseStudy[] = scored.map((entry, position) => ({
    record: entry.record,
    breakdown: entry.breakdown,
    rank: position + 1,
  }));

  const winner: Maybe<ScoredCaseStudy> = rankedCorpus[0] ?? UNKNOWN;
  const runnerUp: Maybe<ScoredCaseStudy> =
    rankedCorpus.length >= MIN_CORPUS_FOR_RUNNER_UP ? (rankedCorpus[1] as ScoredCaseStudy) : UNKNOWN;

  const decidingDimensions =
    winner !== UNKNOWN && runnerUp !== UNKNOWN
      ? computeDecidingDimensions(winner, runnerUp)
      : [];

  const comparisonStatement: Maybe<string> =
    winner !== UNKNOWN && runnerUp !== UNKNOWN
      ? buildComparisonStatement(winner, runnerUp, decidingDimensions)
      : UNKNOWN;

  return {
    corpusSize,
    rankedCorpus,
    winner,
    runnerUp,
    decidingDimensions,
    comparisonStatement,
    corpusUnderfilled: corpusSize < MIN_CORPUS_FOR_RUNNER_UP,
  };
}

/**
 * The rubric dimensions on which the winner's weighted contribution strictly
 * exceeds the runner-up's, in canonical `RUBRIC_WEIGHTS` order. Because the
 * match score is the sum of the four contributions, whenever the winner's score
 * strictly exceeds the runner-up's at least one dimension qualifies, so the
 * returned list is non-empty in that case (Req 8.5, Property 23).
 */
function computeDecidingDimensions(
  winner: ScoredCaseStudy,
  runnerUp: ScoredCaseStudy,
): RubricDimension[] {
  const runnerByDimension = new Map<RubricDimension, DimensionScore>();
  for (const dim of runnerUp.breakdown.dimensions) {
    runnerByDimension.set(dim.dimension, dim);
  }

  const deciding: RubricDimension[] = [];
  for (const winnerDim of winner.breakdown.dimensions) {
    const runnerDim = runnerByDimension.get(winnerDim.dimension);
    const runnerContribution = runnerDim ? runnerDim.contribution : 0;
    if (winnerDim.contribution > runnerContribution) {
      deciding.push(winnerDim.dimension);
    }
  }
  return deciding;
}

/**
 * A plain-language comparison statement explaining why the winner's match score
 * beat the runner-up's, naming the deciding dimensions and their contribution
 * gaps (Req 8.5). Falls back to a tie explanation when no dimension separates
 * the two records.
 */
function buildComparisonStatement(
  winner: ScoredCaseStudy,
  runnerUp: ScoredCaseStudy,
  decidingDimensions: RubricDimension[],
): string {
  const winnerScore = winner.breakdown.matchScore.toFixed(4);
  const runnerScore = runnerUp.breakdown.matchScore.toFixed(4);

  if (decidingDimensions.length === 0) {
    return (
      `The rank-1 case study matched the rank-2 case study at ${winnerScore}; ` +
      `no single rubric dimension separated them, so the tie was broken deterministically.`
    );
  }

  const runnerByDimension = new Map<RubricDimension, DimensionScore>();
  for (const dim of runnerUp.breakdown.dimensions) {
    runnerByDimension.set(dim.dimension, dim);
  }
  const winnerByDimension = new Map<RubricDimension, DimensionScore>();
  for (const dim of winner.breakdown.dimensions) {
    winnerByDimension.set(dim.dimension, dim);
  }

  const clauses = decidingDimensions.map((dimension) => {
    const winnerContribution = winnerByDimension.get(dimension)?.contribution ?? 0;
    const runnerContribution = runnerByDimension.get(dimension)?.contribution ?? 0;
    return (
      `${dimension} (${winnerContribution.toFixed(4)} vs ${runnerContribution.toFixed(4)})`
    );
  });

  const dimensionList =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;

  return (
    `The rank-1 case study scored ${winnerScore} against the runner-up's ${runnerScore}, ` +
    `winning on ${dimensionList}, where its weighted contribution was strictly higher.`
  );
}
