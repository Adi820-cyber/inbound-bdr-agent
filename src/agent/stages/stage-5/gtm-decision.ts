/**
 * Stage 5 GTM decision function (Req 9.2, 9.6).
 *
 * A pure, deterministic decision core. No LLM, no network, no I/O, and — by
 * mandate of Req 9.6 — no string literal naming a company, a person, an email
 * address, or a referral organization. The motion is derived exclusively from
 * typed `LeadProfile`-attribute signals and retrieved partner-evidence fields,
 * so a run that differs only in company/contact/referral names produces an
 * identical motion, partner type, and complexity score.
 *
 * `decideGtmMotion` computes:
 *   - a `complexityScore` from the typed complexity signals,
 *   - a `direct_ae` / `partner_led` motion from partner evidence and whether the
 *     lead sits in a vendor headquarters (direct-coverage) region,
 *   - a `derivedWithoutPartnerEvidence` flag (true whenever no partner evidence
 *     was retrieved — Req 9.5), and
 *   - a `partnerType`, classified only for `partner_led` motions by counting
 *     hits of generic category vocabularies over the retrieved partner text.
 *
 * `partnerType` classification reads only generic retrieved-text spans, never
 * `partnerNames`, so it too is free of company-name branching (Req 9.6).
 */

import type {
  ComplexityAssessment,
  GtmMotion,
  Maybe,
  PartnerType,
  Unknown,
} from "../../contracts";
import { UNKNOWN } from "../../contracts";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** The typed complexity signals the score is computed from (mirrors the contract). */
export type GtmComplexitySignals = ComplexityAssessment["signals"];

/**
 * Retrieved partner evidence. `partnerTypeHints` holds generic partner-page text
 * spans used only for vocabulary classification; `partnerNames` is kept for the
 * recommendation's audit trail but is never read by the decision logic.
 */
export interface GtmPartnerEvidenceInput {
  found: boolean;
  partnerNames: string[];
  partnerTypeHints: string[]; // retrieved partner-page text spans
  sourceUrl: Maybe<string>; // ledger-checked upstream
}

/** All typed inputs the GTM decision consumes. No company/person/referral literal. */
export interface GtmDecisionInputs {
  leadCountry: Maybe<string>; // generic country attribute
  leadRegion: Maybe<string>; // derived from a generic country→region map
  isHeadquartersRegion: boolean; // lead region ∈ vendor direct-coverage regions (config)
  complexitySignals: GtmComplexitySignals;
  partnerEvidence: GtmPartnerEvidenceInput;
}

/** The pure decision result: motion + full complexity assessment + partner type. */
export interface GtmDecision {
  motion: GtmMotion; // (Req 9.2)
  complexity: ComplexityAssessment;
  partnerType: Maybe<PartnerType>; // required when partner_led (Req 9.4)
  derivedWithoutPartnerEvidence: boolean; // (Req 9.5)
}

// ---------------------------------------------------------------------------
// Generic partner-type vocabularies (Req 9.6 — no company / person names)
// ---------------------------------------------------------------------------

/**
 * Indicative retrieved-text vocabulary per partner category. Every term is a
 * generic industry descriptor, never an organization name, so classification
 * generalizes to any partner rather than the fixed demo data.
 */
const PARTNER_TYPE_VOCAB: Record<Exclude<PartnerType, Unknown>, readonly string[]> = {
  systems_integrator: ["integration", "deployment", "end-to-end", "si"],
  drone_service_provider: ["drone-as-a-service", "flight operations", "pilot services"],
  hardware_reseller: ["reseller", "distributor", "authorized dealer"],
  industrial_automation_consultancy: ["automation consulting", "industrial iot advisory"],
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Escape a literal string for safe embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count non-overlapping occurrences of `term` in `haystack`, bounded so an
 * alphanumeric run does not partially match (e.g. `"si"` does not match inside
 * `"vision"`). `haystack` is assumed already lowercased.
 */
function countOccurrences(haystack: string, term: string): number {
  if (term.length === 0) return 0;
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`, "g");
  const matches = haystack.match(pattern);
  return matches ? matches.length : 0;
}

/** True when a `Maybe<number>` carries a usable numeric value. */
function isKnownNumber(value: Maybe<number>): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Complexity score
// ---------------------------------------------------------------------------

/**
 * Deterministic complexity score over the typed signals:
 *
 *   siteCount >= 3 → 2 | siteCount >= 2 → 1 | else 0
 *   + continuousOperations ? 1 : 0
 *   + regulatedEnvironment ? 1 : 0
 *   + multiStakeholder     ? 1 : 0
 *   + dealSizeIndicator=large ? 2 : dealSizeIndicator=mid ? 1 : 0
 *
 * `"unknown"` site count and deal size contribute 0.
 */
export function computeComplexityScore(signals: GtmComplexitySignals): number {
  const sites = signals.siteCount;
  const siteContribution = isKnownNumber(sites) ? (sites >= 3 ? 2 : sites >= 2 ? 1 : 0) : 0;

  const dealContribution =
    signals.dealSizeIndicator === "large" ? 2 : signals.dealSizeIndicator === "mid" ? 1 : 0;

  return (
    siteContribution +
    (signals.continuousOperations ? 1 : 0) +
    (signals.regulatedEnvironment ? 1 : 0) +
    (signals.multiStakeholder ? 1 : 0) +
    dealContribution
  );
}

/** Build a deterministic, name-free explanation of the complexity score. */
function buildComplexityExplanation(signals: GtmComplexitySignals, score: number): string {
  const sites = signals.siteCount;
  const parts: string[] = [
    `site count ${isKnownNumber(sites) ? String(sites) : UNKNOWN} → +${
      isKnownNumber(sites) ? (sites >= 3 ? 2 : sites >= 2 ? 1 : 0) : 0
    }`,
    `continuous operations ${signals.continuousOperations ? "yes → +1" : "no → +0"}`,
    `regulated environment ${signals.regulatedEnvironment ? "yes → +1" : "no → +0"}`,
    `multi-stakeholder ${signals.multiStakeholder ? "yes → +1" : "no → +0"}`,
    `deal size ${signals.dealSizeIndicator} → +${
      signals.dealSizeIndicator === "large" ? 2 : signals.dealSizeIndicator === "mid" ? 1 : 0
    }`,
  ];
  return `Complexity score ${score}: ${parts.join("; ")}.`;
}

// ---------------------------------------------------------------------------
// Partner-type classification
// ---------------------------------------------------------------------------

/**
 * Classify the partner category by counting generic-vocabulary hits over the
 * retrieved partner text. The highest hit count wins; a tie between categories
 * or zero total hits yields `"unknown"`. Reads only generic text, never partner
 * names, so no company/person literal drives the result (Req 9.6).
 */
export function classifyPartnerType(partnerText: readonly string[]): Maybe<PartnerType> {
  const haystack = partnerText.join(" \n ").toLowerCase();

  let best: Exclude<PartnerType, Unknown> | null = null;
  let bestCount = 0;
  let tieAtBest = false;

  for (const [type, vocab] of Object.entries(PARTNER_TYPE_VOCAB) as [
    Exclude<PartnerType, Unknown>,
    readonly string[],
  ][]) {
    let count = 0;
    for (const term of vocab) count += countOccurrences(haystack, term);

    if (count > bestCount) {
      bestCount = count;
      best = type;
      tieAtBest = false;
    } else if (count === bestCount && count > 0) {
      tieAtBest = true;
    }
  }

  if (best === null || bestCount === 0 || tieAtBest) return UNKNOWN;
  return best;
}

// ---------------------------------------------------------------------------
// Motion decision
// ---------------------------------------------------------------------------

/**
 * Decide the GTM motion from typed attribute and evidence inputs only.
 *
 *   partnerEvidence.found AND NOT isHeadquartersRegion → partner_led
 *   otherwise                                          → direct_ae
 *
 * `derivedWithoutPartnerEvidence` is true whenever no partner evidence was
 * retrieved (Req 9.5). `partnerType` is classified only for `partner_led`
 * motions; `direct_ae` carries `"unknown"`.
 */
export function decideGtmMotion(inputs: GtmDecisionInputs): GtmDecision {
  const complexityScore = computeComplexityScore(inputs.complexitySignals);

  const partnerLed = inputs.partnerEvidence.found && !inputs.isHeadquartersRegion;
  const motion: GtmMotion = partnerLed ? "partner_led" : "direct_ae";

  const partnerType: Maybe<PartnerType> = partnerLed
    ? classifyPartnerType(inputs.partnerEvidence.partnerTypeHints)
    : UNKNOWN;

  const complexity: ComplexityAssessment = {
    complexityScore,
    signals: inputs.complexitySignals,
    explanation: buildComplexityExplanation(inputs.complexitySignals, complexityScore),
  };

  return {
    motion,
    complexity,
    partnerType,
    derivedWithoutPartnerEvidence: !inputs.partnerEvidence.found,
  };
}
