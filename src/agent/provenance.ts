/**
 * Provenance enforcement (Req 4.7, 4.9, 5.1, 5.2, 5.3, 5.6).
 *
 * This is the orchestrator-side half of the anti-fabrication control. Stage
 * modules propose claims with `sourceUrl`s; the fetch ledger records every URL
 * the Research Toolbelt actually requested and whether it returned a success
 * (2xx). After Stage 2 and Stage 5 the orchestrator runs the claims in this
 * module through `isLedgered`, which is the ONE authority that can accept a
 * URL. The LLM never participates in the check, so it cannot smuggle a
 * plausible-looking but never-fetched URL past it (design "Provenance
 * enforcement", orchestrator responsibility #6).
 *
 * The rules enforced here:
 *  - A `verified` claim whose `sourceUrl` is not ledgered-with-success is
 *    rejected: its claim text, source URL, and verification status all collapse
 *    to the Unknown_Marker, a `rejectionReason` is attached, and a
 *    `validation_error` Stage_Event naming the rejected URL is emitted
 *    (Req 5.2, 5.3).
 *  - An accepted claim is kept. `retrievedAt` already comes from the ledger via
 *    Stage 2 (Req 4.9); this module never invents one.
 *  - Every `NumericFigure` whose `sourceUrl` is not ledgered-with-success is
 *    dropped, because a figure must cite the page it was retrieved from
 *    (Req 5.6).
 *  - The same check gates Stage 4 case-study source URLs and the Stage 5
 *    partner-evidence source URL.
 *
 * These functions are pure with respect to their inputs: they never mutate the
 * `report`, `record`, or `recommendation` passed in, returning new objects
 * instead. Their only side effect is calling `emit`.
 */

import type {
  CaseStudyRecord,
  GtmRecommendation,
  NumericFigure,
  PartnerEvidence,
  ResearchClaim,
  ResearchDimension,
  ResearchReport,
  StageEvent,
  StageNumber,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";

/** Predicate that returns true only when `url` has a ledgered 2xx entry. */
export type IsLedgered = (url: string) => boolean;

/** The orchestrator's event sink, minus the fields it fills in itself. */
export type ProvenanceEmit = (
  event: Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">,
) => void;

/** Stage attribution for emitted provenance events. */
interface StageInfo {
  stage: StageNumber;
  stageName: string;
}

const STAGE_2: StageInfo = { stage: 2, stageName: "Researcher" };
const STAGE_4: StageInfo = { stage: 4, stageName: "Matcher" };
const STAGE_5: StageInfo = { stage: 5, stageName: "GTM Advisor" };

/**
 * True when `sourceUrl` is a concrete, ledgered-with-success URL. The
 * Unknown_Marker and empty/absent values are never ledgered.
 */
function isLedgeredSource(sourceUrl: string | typeof UNKNOWN, isLedgered: IsLedgered): boolean {
  if (typeof sourceUrl !== "string") return false;
  if (sourceUrl === UNKNOWN || sourceUrl.trim().length === 0) return false;
  return isLedgered(sourceUrl);
}

/**
 * Keep only numeric figures whose `sourceUrl` is ledgered-with-success
 * (Req 5.6). A figure that cannot name the page it came from is dropped rather
 * than displayed unsourced.
 */
function keepLedgeredFigures(
  figures: NumericFigure[],
  isLedgered: IsLedgered,
): NumericFigure[] {
  return figures.filter((figure) => isLedgeredSource(figure.sourceUrl, isLedgered));
}

/**
 * Run one Research_Claim through the provenance check.
 *
 * A claim is only subject to rejection when it presents itself as `verified`;
 * claims already marked `unknown` or `stale` are passed through with their
 * numeric figures filtered. A `verified` claim with an unledgered `sourceUrl`
 * is rejected per Req 5.2/5.3 and its URL is named in a `validation_error`
 * event. Returns a new claim; the input is never mutated.
 */
function filterClaim(
  claim: ResearchClaim,
  isLedgered: IsLedgered,
  emit: ProvenanceEmit,
): ResearchClaim {
  const numericFigures = keepLedgeredFigures(claim.numericFigures, isLedgered);

  if (claim.verificationStatus !== "verified") {
    // Not asserting verification — nothing to reject, but still enforce Req 5.6.
    return { ...claim, numericFigures };
  }

  if (isLedgeredSource(claim.sourceUrl, isLedgered)) {
    // Accepted. `retrievedAt` already came from the ledger (Req 4.9); re-affirm
    // by leaving it untouched.
    return { ...claim, numericFigures };
  }

  // Rejected: the URL was never fetched-with-success during this run.
  const rejectedUrl = typeof claim.sourceUrl === "string" ? claim.sourceUrl : UNKNOWN;
  const rejectionReason =
    rejectedUrl === UNKNOWN
      ? `Claim ${claim.claimId} was marked verified but carried no source URL.`
      : `Claim ${claim.claimId} cited "${rejectedUrl}", which was not fetched with a success response during this run.`;

  emit({
    stage: STAGE_2.stage,
    stageName: STAGE_2.stageName,
    type: "validation_error",
    message: `Rejected unledgered source for claim ${claim.claimId}: ${rejectedUrl}`,
    rejectedUrl,
  });

  return {
    ...claim,
    claimText: UNKNOWN,
    sourceUrl: UNKNOWN,
    supportingQuote: UNKNOWN,
    retrievedAt: UNKNOWN,
    verificationStatus: "unknown",
    numericFigures,
    rejectionReason,
  };
}

/**
 * Cross-check every claim in a Research_Report against the fetch ledger and
 * return a new report with unledgered claims rejected and unledgered numeric
 * figures dropped (Req 5.1, 5.2, 5.3, 5.6). Rejections emit a `validation_error`
 * naming the rejected URL.
 *
 * `verifiedClaimCount` and `dimensionsWithNoSource` are recomputed so the
 * post-filter report is internally consistent and the Run_Console limitations
 * section reflects reality (Req 5.7).
 */
export function applyProvenanceFilter(
  report: ResearchReport,
  isLedgered: IsLedgered,
  emit: ProvenanceEmit,
): ResearchReport {
  // Defensive: the provenance gate must never be the thing that crashes a run.
  // A stage output that reached here without a well-formed `claims` array (a
  // degraded stage, or a shape the schema accepted loosely) is returned
  // unchanged rather than throwing — the run degrades, per Req 17.1/17.6.
  if (report === null || typeof report !== "object" || !Array.isArray(report.claims)) {
    return report;
  }

  const claims = report.claims.map((claim) => filterClaim(claim, isLedgered, emit));

  const verifiedClaimCount = claims.filter((c) => c.verificationStatus === "verified").length;

  // A dimension has "no source" when none of its claims survived as verified or
  // stale. Recompute from the filtered claims so a dimension whose only verified
  // claim was just rejected is now listed as unsourced.
  const dimensionsWithNoSource: ResearchDimension[] = [];
  const byDimension =
    report.claimsByDimension !== null && typeof report.claimsByDimension === "object"
      ? report.claimsByDimension
      : {};
  for (const [dimension, claimIds] of Object.entries(byDimension) as [
    ResearchDimension,
    string[],
  ][]) {
    const ids = Array.isArray(claimIds) ? claimIds : [];
    const hasSource = claims.some(
      (c) =>
        ids.includes(c.claimId) &&
        (c.verificationStatus === "verified" || c.verificationStatus === "stale"),
    );
    if (!hasSource) dimensionsWithNoSource.push(dimension);
  }

  return {
    ...report,
    claims,
    dimensionsWithNoSource,
    verifiedClaimCount,
  };
}

/**
 * Verify a Stage 4 Case_Study_Record's `sourceUrl` against the ledger
 * (Req 5.3). A record whose URL is ledgered-with-success is returned unchanged.
 * Otherwise it is rejected: verification collapses to the Unknown_Marker and a
 * `validation_error` naming the rejected URL is emitted. The input is never
 * mutated.
 *
 * `"stale"` records sourced from the Cached_Corpus are exempt — their URLs were
 * captured in a prior run and are not expected to appear in this run's ledger
 * (Req 7.6).
 */
export function verifyCaseStudyProvenance(
  record: CaseStudyRecord,
  isLedgered: IsLedgered,
  emit: ProvenanceEmit,
): CaseStudyRecord {
  if (record.verificationStatus !== "verified") {
    return record;
  }

  if (isLedgeredSource(record.sourceUrl, isLedgered)) {
    return record;
  }

  const rejectedUrl =
    typeof record.sourceUrl === "string" && record.sourceUrl.length > 0
      ? record.sourceUrl
      : UNKNOWN;

  emit({
    stage: STAGE_4.stage,
    stageName: STAGE_4.stageName,
    type: "validation_error",
    message: `Rejected unledgered case-study source: ${rejectedUrl}`,
    rejectedUrl,
  });

  return {
    ...record,
    verificationStatus: "unknown",
    retrievedAt: UNKNOWN,
  };
}

/**
 * Verify the Stage 5 partner-evidence `sourceUrl` on a GTM_Recommendation
 * against the ledger (Req 5.3, 9.4). When partner evidence claims a URL that is
 * not ledgered-with-success, the evidence is downgraded to "not found": its
 * URL, quote, and timestamp collapse to the Unknown_Marker,
 * `derivedWithoutPartnerEvidence` is set, and a `validation_error` naming the
 * rejected URL is emitted. The input is never mutated.
 */
export function verifyPartnerEvidenceProvenance(
  recommendation: GtmRecommendation,
  isLedgered: IsLedgered,
  emit: ProvenanceEmit,
): GtmRecommendation {
  const evidence = recommendation.regionalPartnerEvidence;

  // Nothing to check when there is no evidence object or it already found none.
  if (typeof evidence !== "object" || evidence === null || !evidence.found) {
    return recommendation;
  }

  if (isLedgeredSource(evidence.sourceUrl, isLedgered)) {
    return recommendation;
  }

  const rejectedUrl =
    typeof evidence.sourceUrl === "string" && evidence.sourceUrl.length > 0
      ? evidence.sourceUrl
      : UNKNOWN;

  emit({
    stage: STAGE_5.stage,
    stageName: STAGE_5.stageName,
    type: "validation_error",
    message: `Rejected unledgered partner-evidence source: ${rejectedUrl}`,
    rejectedUrl,
  });

  const rejectedEvidence: PartnerEvidence = {
    found: false,
    partnerNames: [],
    sourceUrl: UNKNOWN,
    supportingQuote: UNKNOWN,
    retrievedAt: UNKNOWN,
  };

  return {
    ...recommendation,
    regionalPartnerEvidence: rejectedEvidence,
    derivedWithoutPartnerEvidence: true,
  };
}
