/**
 * Stage 4 scoring rubric (Req 8.1, 8.2, 8.6, 8.8).
 *
 * A pure, deterministic scoring core. No LLM, no network, no I/O, and — by
 * mandate of Req 8.8 — no string literal naming a company, a person, an email
 * address, or a referral organization. Every branch is keyed to generic
 * industry-taxonomy and geography tables plus a lemmatized domain vocabulary,
 * so the logic generalizes to any lead rather than the fixed demo lead.
 *
 * The rubric scores a single `CaseStudyRecord` against a `LeadProfile` across
 * four dimensions. Each dimension is its own pure sub-score function comparing
 * exactly one `LeadProfile` field (family) to one `CaseStudyRecord` field
 * (family) and returning a normalized `[0,1]` sub-score. `"unknown"` on either
 * side scores `0.0` and is flagged `unknownInput: true` rather than being
 * silently treated as a mismatch. The weighted sum of the four sub-scores is
 * rounded to four decimals and re-clamped to `[0,1]` so floating-point drift
 * can never produce a value outside the closed interval (Req 8.6).
 */

import type {
  CaseStudyRecord,
  DimensionScore,
  LeadProfile,
  Maybe,
  RubricDimension,
  ScoreBreakdown,
} from "../../contracts";
import { UNKNOWN } from "../../contracts";

// ---------------------------------------------------------------------------
// Weights (Req 8.2) — sum to exactly 1.0
// ---------------------------------------------------------------------------

export const RUBRIC_WEIGHTS: Record<RubricDimension, number> = {
  industry: 0.35,
  geography: 0.25,
  useCase: 0.3,
  partnerOverlap: 0.1,
};

// ---------------------------------------------------------------------------
// Generic reference tables (Req 8.8 — no company / person / referral-org names)
// ---------------------------------------------------------------------------

/**
 * Generic industry taxonomy. Each entry maps a normalized industry term to the
 * set of broader parent buckets it belongs to. Two industries "share a parent"
 * when their bucket sets intersect, which earns the taxonomy bonus even when
 * the surface tokens differ (e.g. `lithium extraction` and `hard-rock mining`
 * both roll up to `mining`).
 *
 * Keys and values are industry/geology vocabulary only — never organization
 * names.
 */
const INDUSTRY_TAXONOMY: Record<string, readonly string[]> = {
  mining: ["mining", "extractives"],
  "lithium extraction": ["mining", "extractives", "chemicals"],
  "hard-rock mining": ["mining", "extractives"],
  "copper mining": ["mining", "extractives"],
  "coal mining": ["mining", "extractives", "energy"],
  "open-pit mining": ["mining", "extractives"],
  quarrying: ["mining", "extractives"],
  metals: ["mining", "extractives"],
  chemicals: ["chemicals", "manufacturing"],
  "oil and gas": ["energy", "extractives"],
  "oil & gas": ["energy", "extractives"],
  petrochemicals: ["energy", "chemicals", "manufacturing"],
  energy: ["energy", "utilities"],
  "renewable energy": ["energy", "utilities"],
  solar: ["energy", "utilities"],
  wind: ["energy", "utilities"],
  utilities: ["utilities"],
  "power generation": ["energy", "utilities"],
  agriculture: ["agriculture"],
  farming: ["agriculture"],
  viticulture: ["agriculture"],
  forestry: ["agriculture"],
  logistics: ["logistics", "supply chain"],
  warehousing: ["logistics", "supply chain"],
  ports: ["logistics", "infrastructure"],
  shipping: ["logistics", "supply chain"],
  construction: ["construction", "infrastructure"],
  infrastructure: ["infrastructure"],
  manufacturing: ["manufacturing"],
  "industrial automation": ["manufacturing", "automation"],
  security: ["security"],
  "public safety": ["security", "government"],
  government: ["government"],
  defense: ["defense", "government"],
  telecommunications: ["telecommunications", "infrastructure"],
  transportation: ["transportation", "infrastructure"],
  railways: ["transportation", "infrastructure"],
};

/**
 * Generic country → region bucket map. Keys are country names only; values are
 * continent / macro-region buckets. Used to award the same-region tier for the
 * geography dimension.
 */
const COUNTRY_TO_REGION: Record<string, string> = {
  chile: "south_america",
  peru: "south_america",
  argentina: "south_america",
  bolivia: "south_america",
  brazil: "south_america",
  colombia: "south_america",
  ecuador: "south_america",
  uruguay: "south_america",
  paraguay: "south_america",
  venezuela: "south_america",
  "united states": "north_america",
  "united states of america": "north_america",
  usa: "north_america",
  us: "north_america",
  canada: "north_america",
  mexico: "north_america",
  "united kingdom": "europe",
  uk: "europe",
  germany: "europe",
  france: "europe",
  spain: "europe",
  italy: "europe",
  portugal: "europe",
  netherlands: "europe",
  sweden: "europe",
  norway: "europe",
  finland: "europe",
  poland: "europe",
  india: "asia",
  china: "asia",
  japan: "asia",
  "south korea": "asia",
  singapore: "asia",
  indonesia: "asia",
  malaysia: "asia",
  philippines: "asia",
  thailand: "asia",
  vietnam: "asia",
  australia: "oceania",
  "new zealand": "oceania",
  "south africa": "africa",
  nigeria: "africa",
  kenya: "africa",
  egypt: "africa",
  ghana: "africa",
  morocco: "africa",
  "saudi arabia": "middle_east",
  "united arab emirates": "middle_east",
  uae: "middle_east",
  qatar: "middle_east",
  israel: "middle_east",
  turkey: "middle_east",
};

/**
 * Generic region-name aliases → the same buckets used by {@link COUNTRY_TO_REGION}.
 * Lets a case-study `region` field expressed as a macro-region ("South America",
 * "LATAM", "APAC") resolve to the same bucket a lead country maps to.
 */
const REGION_ALIASES: Record<string, string> = {
  "south america": "south_america",
  "latin america": "south_america",
  latam: "south_america",
  andean: "south_america",
  "north america": "north_america",
  nam: "north_america",
  europe: "europe",
  emea: "europe",
  asia: "asia",
  apac: "asia",
  "asia pacific": "asia",
  "asia-pacific": "asia",
  oceania: "oceania",
  anz: "oceania",
  africa: "africa",
  "middle east": "middle_east",
  mena: "middle_east",
};

/**
 * Lemmatized domain vocabulary for the use-case dimension. Tokens in this set
 * carry extra weight in the overlap computation because they are the terms that
 * actually distinguish one operational use case from another.
 */
const DOMAIN_VOCAB: ReadonlySet<string> = new Set([
  "inspection",
  "patrol",
  "stockpile",
  "survey",
  "thermal",
  "autonomous",
  "continuous",
  "safety",
  "security",
  "mapping",
  "monitoring",
  "surveillance",
  "volumetric",
  "perimeter",
  "compliance",
  "aerial",
  "inventory",
  "asset",
  "maintenance",
  "emergency",
  "response",
]);

/** Normalizes surface tokens to a shared lemma so plurals/variants align. */
const LEMMA_MAP: Record<string, string> = {
  inspections: "inspection",
  inspecting: "inspection",
  inspect: "inspection",
  patrols: "patrol",
  patrolling: "patrol",
  stockpiles: "stockpile",
  surveys: "survey",
  surveying: "survey",
  autonomously: "autonomous",
  autonomy: "autonomous",
  "24/7": "continuous",
  "24x7": "continuous",
  round_the_clock: "continuous",
  continuously: "continuous",
  monitor: "monitoring",
  monitored: "monitoring",
  maps: "mapping",
  mapped: "mapping",
  assets: "asset",
  inventories: "inventory",
};

/** Generic corporate-suffix stopwords stripped before partner-name comparison. */
const ORG_STOPWORDS: ReadonlySet<string> = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "llc",
  "plc",
  "group",
  "holdings",
  "company",
  "co",
  "sa",
  "sas",
  "gmbh",
  "the",
  "and",
]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** True when a `Maybe<string>` should be treated as absent for scoring. */
function isUnknown(value: Maybe<string> | undefined): boolean {
  return value === undefined || value === UNKNOWN || normalize(value) === "";
}

/** Lowercase, trim, and collapse internal whitespace. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Clamp a number to the closed interval [0, 1]. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Round to four decimals. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Split text into normalized alphanumeric tokens, dropping empties. */
function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9/]+/)
    .filter((t) => t.length > 0);
}

/** Apply the lemma map to a single token. */
function lemma(token: string): string {
  return LEMMA_MAP[token] ?? token;
}

/** Plain Jaccard overlap of two token sets. Empty union → 0. */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** The set of taxonomy parent buckets an industry string belongs to. */
function taxonomyParents(industry: string): Set<string> {
  const parents = new Set<string>();
  const norm = normalize(industry);
  // Whole-string membership.
  if (Object.prototype.hasOwnProperty.call(INDUSTRY_TAXONOMY, norm)) {
    const whole = INDUSTRY_TAXONOMY[norm];
    if (Array.isArray(whole)) for (const p of whole) parents.add(p);
  }
  // Multi-word taxonomy keys contained in the industry text.
  for (const key of Object.keys(INDUSTRY_TAXONOMY)) {
    if (key.includes(" ") && norm.includes(key)) {
      const buckets = INDUSTRY_TAXONOMY[key];
      if (Array.isArray(buckets)) for (const p of buckets) parents.add(p);
    }
  }
  // Single-token membership.
  for (const token of tokenize(norm)) {
    if (Object.prototype.hasOwnProperty.call(INDUSTRY_TAXONOMY, token)) {
      const buckets = INDUSTRY_TAXONOMY[token];
      if (Array.isArray(buckets)) for (const p of buckets) parents.add(p);
    }
  }
  return parents;
}

/** Resolve a geography string to a region bucket, or undefined if unknown. */
function regionBucket(value: string): string | undefined {
  const norm = normalize(value);
  if (COUNTRY_TO_REGION[norm]) return COUNTRY_TO_REGION[norm];
  if (REGION_ALIASES[norm]) return REGION_ALIASES[norm];
  // Try any contained alias/country token.
  for (const token of tokenize(norm)) {
    if (COUNTRY_TO_REGION[token]) return COUNTRY_TO_REGION[token];
    if (REGION_ALIASES[token]) return REGION_ALIASES[token];
  }
  for (const alias of Object.keys(REGION_ALIASES)) {
    if (alias.includes(" ") && norm.includes(alias)) return REGION_ALIASES[alias];
  }
  return undefined;
}

/**
 * Derive a geography hint from free-text (the lead's stated use case) by
 * scanning for the first recognized country or region token. Returns the
 * matched surface term, not the bucket, so it can be surfaced as `leadValue`.
 */
function geographyHint(text: string): string | undefined {
  const norm = normalize(text);
  for (const country of Object.keys(COUNTRY_TO_REGION)) {
    if (country.includes(" ") ? norm.includes(country) : tokenize(norm).includes(country)) {
      return country;
    }
  }
  for (const region of Object.keys(REGION_ALIASES)) {
    if (region.includes(" ") ? norm.includes(region) : tokenize(norm).includes(region)) {
      return region;
    }
  }
  return undefined;
}

/** Assemble a `DimensionScore`, clamping the sub-score into [0,1]. */
function buildDimension(
  dimension: RubricDimension,
  subScoreRaw: number,
  leadValue: Maybe<string>,
  caseStudyValue: Maybe<string>,
  unknownInput: boolean,
  reason: string,
): DimensionScore {
  const weight = RUBRIC_WEIGHTS[dimension];
  const subScore = clamp01(subScoreRaw);
  return {
    dimension,
    weight,
    subScore,
    contribution: weight * subScore,
    leadValue,
    caseStudyValue,
    unknownInput,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Per-dimension sub-score functions (each compares one lead field family to
// one case-study field family). All are pure and total.
// ---------------------------------------------------------------------------

/**
 * Industry (weight 0.35). Compares `leadProfile.industry` with `record.industry`
 * via normalized-token Jaccard plus a shared-taxonomy-parent bonus. Exact
 * normalized equality scores 1.0.
 */
export function scoreIndustry(lead: LeadProfile, caseStudy: CaseStudyRecord): DimensionScore {
  const leadValue: Maybe<string> = isUnknown(lead.industry) ? UNKNOWN : (lead.industry as string);
  const csValue: Maybe<string> = isUnknown(caseStudy.industry)
    ? UNKNOWN
    : (caseStudy.industry as string);

  if (leadValue === UNKNOWN || csValue === UNKNOWN) {
    return buildDimension(
      "industry",
      0,
      leadValue,
      csValue,
      true,
      "Industry unknown on at least one side; scored 0.0.",
    );
  }

  const leadNorm = normalize(leadValue);
  const csNorm = normalize(csValue);
  if (leadNorm === csNorm) {
    return buildDimension("industry", 1, leadValue, csValue, false, "Exact industry match.");
  }

  const leadTokens = new Set(tokenize(leadNorm));
  const csTokens = new Set(tokenize(csNorm));
  const overlap = jaccard(leadTokens, csTokens);

  const leadParents = taxonomyParents(leadNorm);
  const csParents = taxonomyParents(csNorm);
  let sharedParent = false;
  for (const p of leadParents) {
    if (csParents.has(p)) {
      sharedParent = true;
      break;
    }
  }

  const PARENT_BONUS = 0.5;
  const subScore = overlap + (sharedParent ? PARENT_BONUS : 0);
  const reason = sharedParent
    ? `Token overlap ${overlap.toFixed(2)} plus shared taxonomy parent.`
    : `Token overlap ${overlap.toFixed(2)}; no shared taxonomy parent.`;
  return buildDimension("industry", subScore, leadValue, csValue, false, reason);
}

/**
 * Geography (weight 0.25). Compares `leadProfile.country` (falling back to a
 * region hint mined from `statedUseCase`) with `record.region`. Exact match
 * 1.0; same region bucket 0.6; otherwise 0.0.
 */
export function scoreGeography(lead: LeadProfile, caseStudy: CaseStudyRecord): DimensionScore {
  // Resolve the lead geography: country first, else a hint from the use case.
  let leadGeo: string | undefined;
  if (!isUnknown(lead.country)) {
    leadGeo = lead.country as string;
  } else if (!isUnknown(lead.statedUseCase)) {
    leadGeo = geographyHint(lead.statedUseCase as string);
  }

  const leadValue: Maybe<string> = leadGeo ? leadGeo : UNKNOWN;
  const csValue: Maybe<string> = isUnknown(caseStudy.region)
    ? UNKNOWN
    : (caseStudy.region as string);

  if (leadValue === UNKNOWN || csValue === UNKNOWN) {
    return buildDimension(
      "geography",
      0,
      leadValue,
      csValue,
      true,
      "Geography unknown on at least one side; scored 0.0.",
    );
  }

  const leadNorm = normalize(leadValue);
  const csNorm = normalize(csValue);
  if (leadNorm === csNorm) {
    return buildDimension("geography", 1, leadValue, csValue, false, "Exact geography match.");
  }

  const leadRegion = regionBucket(leadValue);
  const csRegion = regionBucket(csValue);
  if (leadRegion !== undefined && csRegion !== undefined && leadRegion === csRegion) {
    return buildDimension(
      "geography",
      0.6,
      leadValue,
      csValue,
      false,
      "Same macro-region bucket via generic region table.",
    );
  }

  return buildDimension(
    "geography",
    0,
    leadValue,
    csValue,
    false,
    "Different geography with no shared region bucket.",
  );
}

/**
 * Use case (weight 0.30). Compares the lead's `statedUseCase` + `statedPainPoints`
 * against `record.useCase` + `record.statedResults` using a weighted token
 * overlap that gives extra weight to lemmatized domain-vocabulary terms.
 */
export function scoreUseCase(lead: LeadProfile, caseStudy: CaseStudyRecord): DimensionScore {
  const leadPrimary: Maybe<string> = isUnknown(lead.statedUseCase)
    ? UNKNOWN
    : (lead.statedUseCase as string);
  const csPrimary: Maybe<string> = isUnknown(caseStudy.useCase)
    ? UNKNOWN
    : (caseStudy.useCase as string);

  const leadPainText = lead.statedPainPoints.join(" ");
  const csResultsText = isUnknown(caseStudy.statedResults)
    ? ""
    : (caseStudy.statedResults as string);

  const leadHasContent = leadPrimary !== UNKNOWN || leadPainText.trim().length > 0;
  const csHasContent = csPrimary !== UNKNOWN || csResultsText.trim().length > 0;

  if (!leadHasContent || !csHasContent) {
    return buildDimension(
      "useCase",
      0,
      leadPrimary,
      csPrimary,
      true,
      "Use case unknown on at least one side; scored 0.0.",
    );
  }

  const leadText = `${leadPrimary === UNKNOWN ? "" : leadPrimary} ${leadPainText}`;
  const csText = `${csPrimary === UNKNOWN ? "" : csPrimary} ${csResultsText}`;
  const leadTokens = new Set(tokenize(leadText).map(lemma));
  const csTokens = new Set(tokenize(csText).map(lemma));

  const weightOf = (t: string): number => (DOMAIN_VOCAB.has(t) ? 2 : 1);
  const union = new Set<string>([...leadTokens, ...csTokens]);
  let unionWeight = 0;
  let intersectionWeight = 0;
  for (const t of union) {
    const w = weightOf(t);
    unionWeight += w;
    if (leadTokens.has(t) && csTokens.has(t)) intersectionWeight += w;
  }
  const subScore = unionWeight === 0 ? 0 : intersectionWeight / unionWeight;

  return buildDimension(
    "useCase",
    subScore,
    leadPrimary,
    csPrimary,
    false,
    `Weighted domain-vocabulary token overlap ${subScore.toFixed(2)}.`,
  );
}

/**
 * Partner overlap (weight 0.10). Compares `leadProfile.referralSource` with
 * `record.namedPartner`. Exact normalized match 1.0; token-level partial match
 * 0.5; no overlap or either side unknown 0.0. Compares two fields only, so it
 * works for any referral organization (Req 8.8).
 */
export function scorePartnerOverlap(
  lead: LeadProfile,
  caseStudy: CaseStudyRecord,
): DimensionScore {
  const leadValue: Maybe<string> = isUnknown(lead.referralSource)
    ? UNKNOWN
    : (lead.referralSource as string);
  const csValue: Maybe<string> = isUnknown(caseStudy.namedPartner)
    ? UNKNOWN
    : (caseStudy.namedPartner as string);

  if (leadValue === UNKNOWN || csValue === UNKNOWN) {
    return buildDimension(
      "partnerOverlap",
      0,
      leadValue,
      csValue,
      true,
      "Partner unknown on at least one side; scored 0.0.",
    );
  }

  const leadNorm = normalize(leadValue);
  const csNorm = normalize(csValue);
  if (leadNorm === csNorm) {
    return buildDimension(
      "partnerOverlap",
      1,
      leadValue,
      csValue,
      false,
      "Exact partner-name match.",
    );
  }

  const leadTokens = new Set(tokenize(leadNorm).filter((t) => !ORG_STOPWORDS.has(t)));
  const csTokens = new Set(tokenize(csNorm).filter((t) => !ORG_STOPWORDS.has(t)));
  let shared = false;
  for (const t of leadTokens) {
    if (csTokens.has(t)) {
      shared = true;
      break;
    }
  }

  return buildDimension(
    "partnerOverlap",
    shared ? 0.5 : 0,
    leadValue,
    csValue,
    false,
    shared ? "Partial partner-name token overlap." : "No partner-name overlap.",
  );
}

// ---------------------------------------------------------------------------
// Aggregate scorer
// ---------------------------------------------------------------------------

/**
 * Score a single case study against a lead across all four rubric dimensions.
 * The `matchScore` is the weighted sum of the (already clamped) sub-scores,
 * rounded to four decimals and re-clamped to `[0,1]` (Req 8.6).
 */
export function scoreCaseStudy(lead: LeadProfile, caseStudy: CaseStudyRecord): ScoreBreakdown {
  const dimensions: DimensionScore[] = [
    scoreIndustry(lead, caseStudy),
    scoreGeography(lead, caseStudy),
    scoreUseCase(lead, caseStudy),
    scorePartnerOverlap(lead, caseStudy),
  ];

  const weightedSum = dimensions.reduce((acc, d) => acc + d.contribution, 0);
  const matchScore = clamp01(round4(weightedSum));

  return { dimensions, matchScore };
}
