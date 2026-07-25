/**
 * Stage 4 — Matcher (`stage-4-matcher.ts`, Req 8.2, 8.3, 8.4; also 7.6, 7.7, 8.9).
 *
 * This module is the orchestration shell for case-study matching. It owns no
 * scoring logic of its own — it wires together three already-built, pure
 * building blocks and the cached-corpus fallback chain:
 *
 *   1. {@link fetchAndEnumerateCaseStudyUrls} + {@link extractCaseStudiesFromPages}
 *      (stage-4/case-study-extractor.ts) — discover the FlytBase case-study
 *      library at runtime and turn each page into a `CaseStudyRecord`.
 *   2. {@link resolveCaseStudyCorpus} (research/cached-corpus) — the fallback
 *      chain: live records win; on an empty live corpus fall back to the
 *      committed cached snapshot (records stamped `"stale"`, provenance
 *      `"cached"`); with neither, signal a stage failure (provenance
 *      `"unavailable"`, Req 7.7).
 *   3. {@link rankCorpus} (stage-4/ranking.ts) + {@link RUBRIC_WEIGHTS}
 *      (stage-4/scoring-rubric.ts) — score every record against the lead across
 *      the four rubric dimensions, rank the corpus, and derive the winner,
 *      runner-up, deciding dimensions, and comparison statement (Req 8.2–8.5).
 *
 * The assembled `MatchResult` carries the ranked corpus with each record's full
 * per-dimension breakdown (so the winner's and runner-up's breakdowns are
 * present, Req 8.3/8.4), the canonical `rubricWeights`, and the provenance
 * fields (`corpusProvenance`, `cachedSnapshotAt`) that the pure ranking layer
 * cannot know.
 *
 * ---------------------------------------------------------------------------
 * The raw-HTML-for-enumeration constraint
 * ---------------------------------------------------------------------------
 * URL enumeration needs the raw anchors of the case-studies index page, but the
 * Research Toolbelt — the SOLE web-egress point (Req 13.3, 13.4) — reduces every
 * fetched page to readability-stripped text with the `<a>` tags removed. A stage
 * module may not open its own socket, so it cannot obtain true raw HTML. The
 * raw-HTML fetcher handed to `fetchAndEnumerateCaseStudyUrls` therefore wraps
 * `toolbelt.fetchPage` (keeping all egress inside the toolbelt and recording the
 * index request in the fetch ledger). Live enumeration only yields URLs insofar
 * as anchors survive the readability pass; when it comes up empty — the common
 * case — the module falls through to the cached corpus. This is the pragmatic,
 * egress-compliant seam the design intends; the cached snapshot supplies the
 * real corpus, and provenance is recorded honestly as `"cached"`.
 */

import type {
  CaseStudyRecord,
  MatchResult,
  Stage,
  StageContext,
} from "../contracts";
import { UNKNOWN } from "../contracts";
import { matchResultSchema } from "../schemas";
import {
  extractCaseStudiesFromPages,
  fetchAndEnumerateCaseStudyUrls,
} from "./stage-4/case-study-extractor";
import { RUBRIC_WEIGHTS } from "./stage-4/scoring-rubric";
import { rankCorpus } from "./stage-4/ranking";
import { resolveCaseStudyCorpus } from "@/research/cached-corpus";

// ---------------------------------------------------------------------------
// Stage identity
// ---------------------------------------------------------------------------

const STAGE = 4 as const;
const STAGE_NAME = "Matcher";
const SOURCE_FILE = "src/agent/stages/stage-4-matcher.ts";
/** Stage 4 depends only on the LeadProfile, which is always present in ctx. */
const DEPENDS_ON = [] as const;

/** The FlytBase case-studies index — discovered at runtime, not hardcoded per lead. */
const FLYTBASE_CASE_STUDIES_INDEX_URL = "https://www.flytbase.com/case-studies";

const STAGE_INFO = { stage: STAGE, stageName: STAGE_NAME } as const;

// ---------------------------------------------------------------------------
// Failure result (Req 7.7): schema-valid MatchResult with everything unknown
// ---------------------------------------------------------------------------

/**
 * The `MatchResult` returned when neither a live nor a cached corpus is
 * available. The stage output must still satisfy `matchResultSchema`, so every
 * field is populated with its "unknown"/empty form and provenance is
 * `"unavailable"` (Req 7.7). The orchestrator maps this to a failed stage.
 */
function unavailableMatchResult(): MatchResult {
  return {
    corpusSize: 0,
    rankedCorpus: [],
    winner: UNKNOWN,
    runnerUp: UNKNOWN,
    comparisonStatement: UNKNOWN,
    decidingDimensions: [],
    rubricWeights: RUBRIC_WEIGHTS,
    corpusProvenance: "unavailable",
    cachedSnapshotAt: UNKNOWN,
  };
}

// ---------------------------------------------------------------------------
// Stage module (Req 13.5)
// ---------------------------------------------------------------------------

export const stage4Matcher: Stage<MatchResult> = {
  stage: STAGE,
  stageName: STAGE_NAME,
  sourceFile: SOURCE_FILE,
  dependsOn: DEPENDS_ON,
  usesToolbelt: true,
  schema: matchResultSchema,

  async run(ctx: StageContext): Promise<MatchResult> {
    const lead = ctx.leadProfile;

    // 1. Attempt LIVE enumeration of the case-study index. The raw-HTML fetcher
    //    wraps the toolbelt so all egress stays inside it and the index request
    //    is ledgered; see the module header for why true raw HTML is not
    //    available to a stage module.
    const fetchRawHtml = async (url: string): Promise<string | null> => {
      const page = await ctx.toolbelt.fetchPage(url);
      return page ? page.text : null;
    };

    let liveRecords: CaseStudyRecord[] = [];
    const urls = await fetchAndEnumerateCaseStudyUrls(
      FLYTBASE_CASE_STUDIES_INDEX_URL,
      fetchRawHtml,
    );

    if (urls.length > 0) {
      ctx.emit({
        stage: STAGE,
        stageName: STAGE_NAME,
        type: "reasoning",
        message: `Enumerated ${urls.length} live case-study URL(s) from the FlytBase index.`,
      });
      // 2. Extract one CaseStudyRecord per enumerated page (one LLM call each).
      liveRecords = await extractCaseStudiesFromPages(urls, {
        toolbelt: ctx.toolbelt,
        llm: ctx.llm,
        emit: ctx.emit,
        stageInfo: STAGE_INFO,
      });
    } else {
      ctx.emit({
        stage: STAGE,
        stageName: STAGE_NAME,
        type: "reasoning",
        message:
          "Live case-study enumeration produced no URLs; deferring to the " +
          "cached-corpus fallback chain.",
      });
    }

    // 3. Resolve the corpus via the fallback chain: live → cached → unavailable.
    //    A cached fallback emits its own snapshot-timestamp StageEvent (Req 7.6).
    const resolution = resolveCaseStudyCorpus(liveRecords, {
      emit: ctx.emit,
      stageInfo: STAGE_INFO,
    });

    // 4. No live and no cached corpus → fail the stage with an "unknown" result
    //    (Req 7.7). The returned MatchResult is still schema-valid.
    if (resolution.shouldFailStage) {
      ctx.emit({
        stage: STAGE,
        stageName: STAGE_NAME,
        type: "reasoning",
        message:
          "Neither a live nor a cached case-study corpus is available; " +
          "the match result is unknown and the stage cannot rank a corpus.",
      });
      return unavailableMatchResult();
    }

    // 5. Score and rank the resolved corpus (pure, deterministic).
    const ranking = rankCorpus(lead, resolution.records);

    // Req 8.9 — record the corpus size when fewer than two records are present.
    if (ranking.corpusUnderfilled) {
      ctx.emit({
        stage: STAGE,
        stageName: STAGE_NAME,
        type: "reasoning",
        message:
          `Case-study corpus underfilled: ${ranking.corpusSize} record(s); ` +
          "no runner-up can be named.",
        inputSummary: `corpusSize=${ranking.corpusSize}`,
      });
    }

    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "reasoning",
      message:
        `Ranked ${ranking.corpusSize} case-study record(s) (provenance ` +
        `"${resolution.provenance}"); ` +
        (ranking.winner === UNKNOWN
          ? "no winner could be selected."
          : `winner match score ${ranking.winner.breakdown.matchScore.toFixed(4)}.`),
    });

    // 6. Assemble the MatchResult: pure ranking output plus the provenance and
    //    rubric-weight fields the ranking layer does not know (Req 8.2–8.4).
    return {
      corpusSize: ranking.corpusSize,
      rankedCorpus: ranking.rankedCorpus,
      winner: ranking.winner,
      runnerUp: ranking.runnerUp,
      comparisonStatement: ranking.comparisonStatement,
      decidingDimensions: ranking.decidingDimensions,
      rubricWeights: RUBRIC_WEIGHTS,
      corpusProvenance: resolution.provenance,
      cachedSnapshotAt: resolution.cachedSnapshotAt,
    };
  },
};

export default stage4Matcher;
