/**
 * Stage 5 — GTM Advisor (`stage-5-gtm-advisor.ts`, Req 9.1, 9.3, 9.4, 9.5).
 *
 * This module is the orchestration shell around the pure decision core in
 * `stage-5/gtm-decision.ts`. It never decides the motion itself and it never
 * lets the LLM decide it either (Req 9.6): the shell only gathers typed inputs,
 * hands them to `decideGtmMotion`, and then narrates the *already-decided*
 * motion. The sequence is:
 *
 *   1. Issue at least one Research Toolbelt search against FlytBase public
 *      material for partner-ecosystem signals, interpolating the lead's
 *      geography into the query (Req 9.1).
 *   2. When a FlytBase partner hit exists, fetch its page so its URL enters the
 *      fetch ledger, then confirm the URL is ledgered with `isLedgered` — the
 *      same anti-fabrication provenance gate every other cited URL passes
 *      through. Only a ledgered partner source counts as retrieved evidence.
 *   3. Assemble `GtmDecisionInputs` from typed `LeadProfile` attributes plus the
 *      (ledger-verified) partner evidence, and call the pure `decideGtmMotion`.
 *   4. Narrate the decided motion with ONE scoped LLM call, referencing the
 *      geography, the deal-complexity assessment, and the presence or absence of
 *      regional partner evidence (Req 9.3). The narration cannot change the
 *      motion; on any LLM failure a deterministic narrative is used instead.
 *   5. When no ledgered partner signal was retrieved, `regionalPartnerEvidence`
 *      is the `"unknown"` marker and `derivedWithoutPartnerEvidence` is `true`,
 *      and the reasoning states the motion was derived without regional partner
 *      evidence (Req 9.5).
 *
 * Every branch here reads typed attributes or ledger state only — never a
 * company, contact, or referral-organization literal — so a run that differs
 * only in those names produces an identical recommendation (Req 9.6).
 */

import { z } from "zod";

import type {
  ComplexityAssessment,
  GtmRecommendation,
  LeadProfile,
  Maybe,
  PartnerEvidence,
  PartnerType,
  QualificationResult,
  SearchHit,
  Stage,
  StageContext,
} from "../contracts";
import { UNKNOWN } from "../contracts";
import { gtmRecommendationSchema } from "../schemas";
import {
  decideGtmMotion,
  type GtmComplexitySignals,
  type GtmDecisionInputs,
} from "./stage-5/gtm-decision";

// ---------------------------------------------------------------------------
// Stage identity
// ---------------------------------------------------------------------------

const STAGE = 5 as const;
const STAGE_NAME = "GTM Advisor";
const SOURCE_FILE = "src/agent/stages/stage-5-gtm-advisor.ts";
const DEPENDS_ON = ["qualification", "match"] as const;

// ---------------------------------------------------------------------------
// Generic reference vocabularies (Req 9.6 — no company / person / referral names)
// ---------------------------------------------------------------------------

/** Host substring identifying FlytBase public material. */
const FLYTBASE_HOST = "flytbase.com";

/**
 * Macro-region buckets the vendor covers directly (no channel partner needed).
 * A lead inside one of these regions is steered to a direct AE motion even when
 * partner material exists. Keyed to generic region-display names produced by the
 * lead normalizer, never to a company name. This is deployment config, not a
 * fact about any particular lead.
 */
const DIRECT_COVERAGE_REGIONS: ReadonlySet<string> = new Set(["north america", "asia"]);

/** Generic terms whose presence in retrieved text indicates partner-ecosystem signal. */
const PARTNER_SIGNAL_TERMS: readonly string[] = [
  "partner",
  "partners",
  "reseller",
  "distributor",
  "systems integrator",
  "system integrator",
  "integration partner",
  "channel",
  "service provider",
  "drone service",
  "authorized",
  "ecosystem",
];

/** Continuous-operations signal vocabulary (typed complexity signal). */
const CONTINUOUS_OPS_TERMS: readonly string[] = [
  "continuous",
  "24/7",
  "24x7",
  "round the clock",
  "around the clock",
  "non-stop",
  "nonstop",
  "always-on",
  "always on",
  "continuous operations",
  "ongoing operations",
];

/** Regulated-environment signal vocabulary (typed complexity signal). */
const REGULATED_TERMS: readonly string[] = [
  "mining",
  "lithium",
  "oil",
  "gas",
  "chemical",
  "chemicals",
  "petrochemical",
  "energy",
  "nuclear",
  "utility",
  "utilities",
  "pharma",
  "defense",
  "defence",
  "aviation",
  "hazardous",
  "regulated",
  "compliance",
  "safety",
  "environmental",
];

/** Multi-stakeholder signal vocabulary (typed complexity signal). */
const MULTI_STAKEHOLDER_TERMS: readonly string[] = [
  "team",
  "teams",
  "stakeholder",
  "stakeholders",
  "committee",
  "leadership",
  "board",
  "budget conversation",
  "cross-functional",
  "departments",
  "multiple teams",
];

/** Large-deal signal vocabulary (typed complexity signal). */
const LARGE_DEAL_TERMS: readonly string[] = [
  "large-scale",
  "large scale",
  "enterprise",
  "nationwide",
  "multi-site",
  "multi site",
  "fleet",
  "global",
];

/** Mid-deal signal vocabulary (typed complexity signal). */
const MID_DEAL_TERMS: readonly string[] = [
  "expand",
  "expansion",
  "scale up",
  "scaling",
  "regional rollout",
  "multiple sites",
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Lowercase, trim, and collapse internal whitespace. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when a `Maybe<string>` carries a usable value. */
function isKnownString(value: Maybe<string>): value is string {
  return value !== UNKNOWN && typeof value === "string" && value.trim().length > 0;
}

/** True when a `Maybe<number>` carries a usable numeric value. */
function isKnownNumber(value: Maybe<number>): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Collapse a `Maybe<string>` to plain text (empty string when unknown). */
function text(value: Maybe<string>): string {
  return isKnownString(value) ? value : "";
}

/** True when the URL points at FlytBase public material. */
function isFlytbaseUrl(url: string): boolean {
  return normalize(url).includes(FLYTBASE_HOST);
}

/** True when any partner-signal term appears in the (already lowercased) text. */
function containsPartnerSignal(haystackLower: string): boolean {
  return PARTNER_SIGNAL_TERMS.some((term) => haystackLower.includes(term));
}

/** Title text of a search hit, or empty string when absent. */
function hitTitle(hit: SearchHit): string {
  return isKnownString(hit.title) ? hit.title : "";
}

/** Snippet text of a search hit, or empty string when absent. */
function hitSnippet(hit: SearchHit): string {
  return isKnownString(hit.snippet) ? hit.snippet : "";
}

/** True when a hit's title or snippet carries a partner-ecosystem signal. */
function hitHasPartnerSignal(hit: SearchHit): boolean {
  return containsPartnerSignal(normalize(`${hitTitle(hit)} ${hitSnippet(hit)}`));
}

/** Deduplicate hits by normalized URL, preserving first-seen order. */
function dedupeByUrl(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = normalize(hit.url);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

/**
 * Extract a supporting quote from retrieved page text: a window around the first
 * partner-signal term, or the leading span when no term is found. Returns the
 * `"unknown"` marker for empty text so nothing is fabricated.
 */
function extractSupportingQuote(pageText: string): Maybe<string> {
  const flat = pageText.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return UNKNOWN;

  const lower = flat.toLowerCase();
  for (const term of PARTNER_SIGNAL_TERMS) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(flat.length, idx + 160);
      return flat.slice(start, end).trim();
    }
  }
  return flat.slice(0, 200).trim();
}

// ---------------------------------------------------------------------------
// Geography resolution
// ---------------------------------------------------------------------------

interface GeographyResolution {
  country: Maybe<string>;
  region: Maybe<string>;
  /** Space-joined geography terms interpolated into the search query. */
  geoPhrase: string;
  /** The single geography value surfaced on the recommendation. */
  geographyConsidered: Maybe<string>;
}

function resolveGeography(lead: LeadProfile): GeographyResolution {
  const { country, region } = lead;
  const parts: string[] = [];
  if (isKnownString(country)) parts.push(country);
  if (isKnownString(region)) parts.push(region);

  const geographyConsidered: Maybe<string> = isKnownString(country)
    ? country
    : isKnownString(region)
      ? region
      : UNKNOWN;

  return {
    country,
    region,
    geoPhrase: parts.join(" "),
    geographyConsidered,
  };
}

/** Build the geography-interpolated FlytBase partner-material queries (Req 9.1). */
function buildQueries(geoPhrase: string): string[] {
  const geo = geoPhrase.trim().length > 0 ? geoPhrase.trim() : "global markets";
  return [
    `FlytBase partner ecosystem reseller systems integrator drone service provider ${geo} site:flytbase.com`,
    `FlytBase channel partners ${geo}`,
  ];
}

// ---------------------------------------------------------------------------
// Complexity-signal derivation (typed attributes only — Req 9.6)
// ---------------------------------------------------------------------------

/** Resolve the upstream qualification output, or `null` when absent/failed. */
function resolveQualification(
  upstream: StageContext["upstream"]["qualification"],
): QualificationResult | null {
  return upstream !== undefined && upstream !== UNKNOWN ? upstream : null;
}

/** Concatenated, normalized lead free-text used for signal detection. */
function leadNarrativeText(lead: LeadProfile): string {
  return normalize(
    [
      text(lead.statedUseCase),
      lead.statedPainPoints.join(" "),
      lead.rawEmail.subject ?? "",
      lead.rawEmail.body ?? "",
    ].join(" "),
  );
}

/** Derive the deal-size indicator from typed attributes and generic text signals. */
function deriveDealSize(
  lead: LeadProfile,
  narrative: string,
  qualification: QualificationResult | null,
): GtmComplexitySignals["dealSizeIndicator"] {
  const sites = lead.siteCount;
  if (isKnownNumber(sites)) {
    if (sites >= 3) return "large";
    if (sites === 2) return "mid";
  }

  if (LARGE_DEAL_TERMS.some((t) => narrative.includes(t))) return "large";
  if (
    qualification &&
    qualification.fitAssessment === "strong_fit" &&
    qualification.priorityScore >= 70
  ) {
    return "large";
  }
  if (MID_DEAL_TERMS.some((t) => narrative.includes(t))) return "mid";
  if (qualification && qualification.priorityScore >= 50) return "mid";
  if (isKnownNumber(sites) && sites <= 1) return "small";
  return UNKNOWN;
}

/** Assemble the typed complexity signals from the lead and qualification output. */
function deriveComplexitySignals(
  lead: LeadProfile,
  qualification: QualificationResult | null,
): GtmComplexitySignals {
  const narrative = leadNarrativeText(lead);
  const industry = normalize(text(lead.industry));

  const continuousOperations = CONTINUOUS_OPS_TERMS.some((t) => narrative.includes(t));
  const regulatedEnvironment = REGULATED_TERMS.some(
    (t) => narrative.includes(t) || industry.includes(t),
  );
  const multiStakeholder =
    isKnownString(lead.division) ||
    MULTI_STAKEHOLDER_TERMS.some((t) => narrative.includes(t)) ||
    (qualification !== null && qualification.knownFields.length >= 4);

  return {
    siteCount: lead.siteCount,
    continuousOperations,
    regulatedEnvironment,
    multiStakeholder,
    dealSizeIndicator: deriveDealSize(lead, narrative, qualification),
  };
}

// ---------------------------------------------------------------------------
// Partner-evidence gathering (search + fetch + ledger check)
// ---------------------------------------------------------------------------

interface PartnerEvidenceResult {
  found: boolean;
  sourceUrl: Maybe<string>;
  supportingQuote: Maybe<string>;
  retrievedAt: Maybe<string>;
  /** Generic retrieved-text spans fed to the pure partner-type classifier. */
  partnerTypeHints: string[];
  partnerNames: string[];
  searchQueriesIssued: number;
  flytbaseHitCount: number;
  sourceUrlLedgered: boolean;
}

/**
 * Query FlytBase public material for partner signals in the lead's geography,
 * then confirm any candidate source URL is present in the fetch ledger with a
 * success status. Only a ledgered partner source counts as retrieved evidence
 * (Req 9.4). At least one search is always issued (Req 9.1).
 */
async function gatherPartnerEvidence(
  ctx: StageContext,
  geoPhrase: string,
): Promise<PartnerEvidenceResult> {
  const queries = buildQueries(geoPhrase);
  let searchQueriesIssued = 0;
  let flytbaseHits: SearchHit[] = [];

  for (const query of queries) {
    searchQueriesIssued += 1;
    const hits = await ctx.toolbelt.search(query, { maxResults: 6 });
    flytbaseHits = flytbaseHits.concat(hits.filter((hit) => isFlytbaseUrl(hit.url)));
    // Stop early once we have a partner-signal hit to fetch.
    if (flytbaseHits.some(hitHasPartnerSignal)) break;
  }

  flytbaseHits = dedupeByUrl(flytbaseHits);

  const empty: PartnerEvidenceResult = {
    found: false,
    sourceUrl: UNKNOWN,
    supportingQuote: UNKNOWN,
    retrievedAt: UNKNOWN,
    partnerTypeHints: [],
    partnerNames: [],
    searchQueriesIssued,
    flytbaseHitCount: flytbaseHits.length,
    sourceUrlLedgered: false,
  };

  const candidate = flytbaseHits.find(hitHasPartnerSignal) ?? flytbaseHits[0];
  if (!candidate) return empty;

  // Fetch the candidate page so its URL is recorded in the fetch ledger.
  const page = await ctx.toolbelt.fetchPage(candidate.url);
  if (!page) return empty;

  // Provenance gate: the source URL must be ledgered with a success status,
  // exactly like any other cited URL (Req 9.4). An unledgered URL is discarded.
  const sourceUrlLedgered = ctx.toolbelt.isLedgered(page.finalUrl);
  if (!sourceUrlLedgered) {
    return { ...empty, flytbaseHitCount: flytbaseHits.length };
  }

  // Confirm an actual partner signal is present in the retrieved material.
  const combined = normalize(`${hitTitle(candidate)} ${hitSnippet(candidate)} ${page.text}`);
  if (!containsPartnerSignal(combined)) {
    return { ...empty, flytbaseHitCount: flytbaseHits.length };
  }

  return {
    found: true,
    sourceUrl: page.finalUrl,
    supportingQuote: extractSupportingQuote(page.text),
    retrievedAt: page.retrievedAt,
    partnerTypeHints: [hitTitle(candidate), hitSnippet(candidate), page.text],
    partnerNames: [],
    searchQueriesIssued,
    flytbaseHitCount: flytbaseHits.length,
    sourceUrlLedgered: true,
  };
}

// ---------------------------------------------------------------------------
// Reasoning narration (one scoped LLM call; deterministic fallback)
// ---------------------------------------------------------------------------

/** The narration schema: the LLM returns prose only, never the decision. */
const narrationSchema = z.object({
  reasoning: z.string().min(1),
});

interface ReasoningInputs {
  motion: GtmRecommendation["motion"];
  geographyConsidered: Maybe<string>;
  complexity: ComplexityAssessment;
  partnerFound: boolean;
  partnerType: Maybe<PartnerType>;
  sourceUrl: Maybe<string>;
  isHeadquartersRegion: boolean;
}

/** Human-readable partner-type label (e.g. `systems_integrator` → `systems integrator`). */
function partnerTypeLabel(partnerType: Maybe<PartnerType>): string {
  return isKnownString(partnerType) ? partnerType.replace(/_/g, " ") : "an unclassified type of";
}

/**
 * Build the deterministic reasoning. Always references the three mandated
 * elements — geography, the deal-complexity assessment, and the presence or
 * absence of regional partner evidence (Req 9.3) — and, when no partner signal
 * was retrieved, states the motion was derived without it (Req 9.5).
 */
function buildDeterministicReasoning(inputs: ReasoningInputs): string {
  const geoText = isKnownString(inputs.geographyConsidered)
    ? inputs.geographyConsidered
    : "an unspecified geography";
  const motionText =
    inputs.motion === "partner_led" ? "a partner-led motion" : "a direct AE-led motion";

  const coverageClause = inputs.isHeadquartersRegion
    ? "The lead sits within a vendor direct-coverage region."
    : "The lead sits outside vendor direct-coverage regions.";

  const partnerClause = inputs.partnerFound
    ? `Regional partner evidence was found in FlytBase public material (${text(inputs.sourceUrl)}), indicating ${partnerTypeLabel(inputs.partnerType)} partner.`
    : "No regional partner signal was retrieved from FlytBase public material, so the motion was derived without regional partner evidence.";

  return [
    `Recommending ${motionText} for a lead in ${geoText}.`,
    inputs.complexity.explanation,
    coverageClause,
    partnerClause,
  ].join(" ");
}

/**
 * Narrate the already-decided motion with one scoped LLM call. The motion is
 * never sent back as a decision — the prompt asks only for prose grounded in the
 * supplied facts. On any failure the deterministic narrative is returned, so the
 * stage degrades instead of throwing (Req 17.1).
 */
async function narrateReasoning(
  ctx: StageContext,
  inputs: ReasoningInputs,
  deterministicReasoning: string,
): Promise<string> {
  const systemPrompt = [
    "You are a go-to-market advisor writing the rationale for a sales-routing decision.",
    "The motion has ALREADY been decided by a deterministic rule engine and must NOT be changed.",
    "Write a concise, factual paragraph that justifies the already-decided motion.",
    "You must reference the lead geography, the deal-complexity assessment, and whether regional partner evidence was found.",
    "Do not invent partner names, URLs, or facts beyond those provided.",
  ].join(" ");

  const userPrompt = [
    `Decided motion: ${inputs.motion}.`,
    `Geography considered: ${text(inputs.geographyConsidered) || UNKNOWN}.`,
    `In a vendor direct-coverage region: ${inputs.isHeadquartersRegion}.`,
    `Complexity assessment: ${inputs.complexity.explanation}`,
    `Regional partner evidence found: ${inputs.partnerFound}.`,
    inputs.partnerFound
      ? `Supporting FlytBase source URL: ${text(inputs.sourceUrl)}. Partner type: ${text(inputs.partnerType) || UNKNOWN}.`
      : "No regional partner evidence was retrieved; state that the motion was derived without it.",
    "Grounding draft you may refine (keep every fact intact):",
    deterministicReasoning,
  ].join("\n");

  try {
    const result = await ctx.llm.completeJson({
      purpose: "stage5_gtm_narration",
      systemPrompt,
      userPrompt,
      schema: narrationSchema,
      maxOutputTokens: 400,
      temperature: 0.2,
    });

    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "llm_call",
      message: "Narrated the already-decided GTM motion.",
      llmCall: {
        provider: ctx.llm.name,
        model: result.modelUsed,
        purpose: "stage5_gtm_narration",
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        attempt: ctx.attempt,
      },
    });

    const narrated = result.value.reasoning.trim();
    return narrated.length > 0 ? narrated : deterministicReasoning;
  } catch {
    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "reasoning",
      message: "GTM narration LLM call failed; using deterministic reasoning.",
    });
    return deterministicReasoning;
  }
}

// ---------------------------------------------------------------------------
// Stage module
// ---------------------------------------------------------------------------

export const stage5GtmAdvisor: Stage<GtmRecommendation> = {
  stage: STAGE,
  stageName: STAGE_NAME,
  sourceFile: SOURCE_FILE,
  dependsOn: DEPENDS_ON,
  usesToolbelt: true,
  schema: gtmRecommendationSchema,

  async run(ctx: StageContext): Promise<GtmRecommendation> {
    const lead = ctx.leadProfile;
    const qualification = resolveQualification(ctx.upstream.qualification);

    // 1. Geography-interpolated FlytBase partner-material search + evidence (Req 9.1).
    const geography = resolveGeography(lead);
    const evidence = await gatherPartnerEvidence(ctx, geography.geoPhrase);

    // 2. Assemble the typed decision inputs (attributes + verified evidence only).
    const complexitySignals = deriveComplexitySignals(lead, qualification);
    const isHeadquartersRegion =
      isKnownString(geography.region) &&
      DIRECT_COVERAGE_REGIONS.has(normalize(geography.region));

    const decisionInputs: GtmDecisionInputs = {
      leadCountry: geography.country,
      leadRegion: geography.region,
      isHeadquartersRegion,
      complexitySignals,
      partnerEvidence: {
        found: evidence.found,
        partnerNames: evidence.partnerNames,
        partnerTypeHints: evidence.partnerTypeHints,
        sourceUrl: evidence.sourceUrl,
      },
    };

    // 3. Pure decision — the LLM never touches this (Req 9.2, 9.6).
    const decision = decideGtmMotion(decisionInputs);

    // 4. Regional partner evidence: an evidence object when found, else the
    //    "unknown" marker with derivedWithoutPartnerEvidence set (Req 9.5).
    const regionalPartnerEvidence: Maybe<PartnerEvidence> = evidence.found
      ? {
          found: true,
          partnerNames: evidence.partnerNames,
          sourceUrl: evidence.sourceUrl,
          supportingQuote: evidence.supportingQuote,
          retrievedAt: evidence.retrievedAt,
        }
      : UNKNOWN;

    // 5. Narrate the decided motion (Req 9.3), with a deterministic fallback.
    const reasoningInputs: ReasoningInputs = {
      motion: decision.motion,
      geographyConsidered: geography.geographyConsidered,
      complexity: decision.complexity,
      partnerFound: evidence.found,
      partnerType: decision.partnerType,
      sourceUrl: evidence.sourceUrl,
      isHeadquartersRegion,
    };
    const deterministicReasoning = buildDeterministicReasoning(reasoningInputs);
    const reasoning = await narrateReasoning(ctx, reasoningInputs, deterministicReasoning);

    // 6. Audit-trail snapshot of every input the decision consumed.
    const decisionInputsSnapshot: Record<string, string | number | boolean> = {
      leadCountry: text(geography.country) || UNKNOWN,
      leadRegion: text(geography.region) || UNKNOWN,
      geographyConsidered: text(geography.geographyConsidered) || UNKNOWN,
      isHeadquartersRegion,
      siteCount: isKnownNumber(complexitySignals.siteCount)
        ? complexitySignals.siteCount
        : UNKNOWN,
      continuousOperations: complexitySignals.continuousOperations,
      regulatedEnvironment: complexitySignals.regulatedEnvironment,
      multiStakeholder: complexitySignals.multiStakeholder,
      dealSizeIndicator: complexitySignals.dealSizeIndicator,
      complexityScore: decision.complexity.complexityScore,
      motion: decision.motion,
      partnerType: text(decision.partnerType) || UNKNOWN,
      partnerEvidenceFound: evidence.found,
      partnerSourceUrl: text(evidence.sourceUrl) || UNKNOWN,
      partnerSourceUrlLedgered: evidence.sourceUrlLedgered,
      derivedWithoutPartnerEvidence: decision.derivedWithoutPartnerEvidence,
      searchQueriesIssued: evidence.searchQueriesIssued,
      flytbaseHitCount: evidence.flytbaseHitCount,
    };

    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "reasoning",
      message:
        `GTM motion "${decision.motion}" derived for ${text(geography.geographyConsidered) || UNKNOWN} ` +
        `(complexity ${decision.complexity.complexityScore}; ` +
        `regional partner evidence ${evidence.found ? "present" : "absent"}).`,
    });

    return {
      motion: decision.motion,
      reasoning,
      geographyConsidered: geography.geographyConsidered,
      complexity: decision.complexity,
      regionalPartnerEvidence,
      derivedWithoutPartnerEvidence: decision.derivedWithoutPartnerEvidence,
      partnerType: decision.partnerType,
      decisionInputsSnapshot,
    };
  },
};

export default stage5GtmAdvisor;
