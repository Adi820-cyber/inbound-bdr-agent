/**
 * Lead normalizer (Req 1.3, 1.4, 1.5).
 *
 * Turns an inbound `RawEmailRecord` into a fully-populated `LeadProfile`. The
 * transform is **total** and **lossless**:
 *  - Total: every `LeadProfile` field is either derived from the raw email or
 *    set to the `UNKNOWN` marker. No field is left `undefined` and nothing is
 *    invented — an un-derivable field becomes `"unknown"`, never a guess.
 *  - Lossless: the original `RawEmailRecord` is preserved verbatim on
 *    `LeadProfile.rawEmail`, so downstream stages and the audit trail can always
 *    recover exactly what arrived.
 *
 * This module is deliberately self-contained: it carries its own generic
 * country→region table rather than importing the Stage 4 rubric's, so lead
 * normalization has no dependency on the scoring core. The rubric keeps its own
 * copy for its own comparison buckets; the two are intentionally decoupled.
 *
 * All derivation is deterministic string parsing — there is no LLM call here.
 * For the Fixed_Lead this yields `referralSource = "Anglo American"` and a
 * `statedTimeline` describing the Q3 internal budget conversation (Req 1.5).
 */

import type { IsoTimestamp, LeadProfile, Maybe, RawEmailRecord } from "./contracts";
import { UNKNOWN } from "./contracts";

// ---------------------------------------------------------------------------
// Generic country → region table (display-name regions). Keyed by country name
// only — no company, person, or referral-organization literals.
// ---------------------------------------------------------------------------

const COUNTRY_TO_REGION: Record<string, string> = {
  chile: "South America",
  peru: "South America",
  argentina: "South America",
  bolivia: "South America",
  brazil: "South America",
  colombia: "South America",
  ecuador: "South America",
  uruguay: "South America",
  paraguay: "South America",
  venezuela: "South America",
  "united states": "North America",
  "united states of america": "North America",
  usa: "North America",
  us: "North America",
  canada: "North America",
  mexico: "North America",
  "united kingdom": "Europe",
  uk: "Europe",
  ireland: "Europe",
  germany: "Europe",
  france: "Europe",
  spain: "Europe",
  italy: "Europe",
  portugal: "Europe",
  netherlands: "Europe",
  belgium: "Europe",
  switzerland: "Europe",
  austria: "Europe",
  sweden: "Europe",
  norway: "Europe",
  denmark: "Europe",
  finland: "Europe",
  poland: "Europe",
  india: "Asia",
  china: "Asia",
  japan: "Asia",
  "south korea": "Asia",
  singapore: "Asia",
  indonesia: "Asia",
  malaysia: "Asia",
  philippines: "Asia",
  thailand: "Asia",
  vietnam: "Asia",
  australia: "Oceania",
  "new zealand": "Oceania",
  "south africa": "Africa",
  nigeria: "Africa",
  kenya: "Africa",
  egypt: "Africa",
  ghana: "Africa",
  morocco: "Africa",
  "saudi arabia": "Middle East",
  "united arab emirates": "Middle East",
  uae: "Middle East",
  qatar: "Middle East",
  israel: "Middle East",
  turkey: "Middle East",
};

/** Small spelled-number vocabulary for site-count parsing (one..twenty). */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/** Comma-delimited title segments that name an org unit rather than a role. */
const DIVISION_CUES = /\b(division|unit|department|group|team|office|business unit)\b/i;

/**
 * Generic industry vocabulary → canonical industry label. Keys are commodity,
 * process, and asset-class terms only — never a company name — so this
 * generalizes to any inbound lead (Req 8.8's spirit applied to normalization).
 *
 * This exists because `industry` is the highest-weighted dimension in the Stage 4
 * scoring rubric (0.35). Leaving it `"unknown"` made that dimension score 0.0 for
 * every case study on every run, so the match was decided by geography and use
 * case alone. The vocabulary below is deliberately conservative: a lead whose
 * text matches nothing still resolves to `"unknown"` rather than a guess (Req 1.4).
 */
const INDUSTRY_VOCABULARY: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "Mining",
    [
      "mining",
      "mine",
      "mines",
      "lithium",
      "copper",
      "iodine",
      "potassium",
      "ore",
      "tailings",
      "open-pit",
      "open pit",
      "salt flat",
      "salar",
      "smelter",
      "quarry",
      "stockpile",
      "concentrator",
    ],
  ],
  ["Oil & Gas", ["oil", "gas", "refinery", "pipeline", "flare stack", "petrochemical", "upstream", "downstream"]],
  ["Solar", ["solar", "photovoltaic", "solar pv", "pv plant"]],
  ["Utilities & Energy", ["utility", "utilities", "substation", "power plant", "transmission line", "hydropower", "grid"]],
  ["Agriculture", ["agriculture", "farm", "farming", "livestock", "plantation", "ranch", "crop", "orchard"]],
  ["Construction & Infrastructure", ["construction", "infrastructure", "building site", "civil works"]],
  ["Ports & Maritime", ["port", "terminal", "container yard", "harbour", "harbor", "maritime"]],
  ["Transportation", ["rail", "railway", "railroad", "highway", "airport", "logistics", "warehouse"]],
  ["Public Safety", ["public safety", "emergency response", "first responder", "fire department", "police"]],
  ["Site Security", ["security", "surveillance", "perimeter", "intrusion", "guarding"]],
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

/** Collapse internal whitespace (including newlines) to single spaces. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Build a filesystem/id-safe slug from arbitrary text. */
function slug(value: string): string {
  const s = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : "unknown";
}

/** Join the raw email body into a single whitespace-normalized string. */
function flatBody(record: RawEmailRecord): string {
  return collapse(record.body ?? "");
}

// ---------------------------------------------------------------------------
// Field derivations — each returns a value or UNKNOWN, never throws.
// ---------------------------------------------------------------------------

function deriveCompanyDomain(email: string): Maybe<string> {
  const at = email.lastIndexOf("@");
  if (at < 0) return UNKNOWN;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 && domain.includes(".") ? domain : UNKNOWN;
}

/**
 * Resolve the country from the contact-form fields when present, otherwise scan
 * the body for the first recognized country name.
 */
function deriveCountry(record: RawEmailRecord): Maybe<string> {
  const formCountry = record.formFields?.country;
  if (!isBlank(formCountry)) return collapse(formCountry as string);

  const body = flatBody(record).toLowerCase();
  for (const country of Object.keys(COUNTRY_TO_REGION)) {
    // Multi-word keys match on substring; single-word keys match on token.
    const found = country.includes(" ")
      ? body.includes(country)
      : new RegExp(`\\b${country}\\b`).test(body);
    if (found) {
      return country.charAt(0).toUpperCase() + country.slice(1);
    }
  }
  return UNKNOWN;
}

/** Map a resolved country to a generic macro-region (Chile → South America). */
function deriveRegion(country: Maybe<string>): Maybe<string> {
  if (country === UNKNOWN) return UNKNOWN;
  const region = COUNTRY_TO_REGION[collapse(country).toLowerCase()];
  return region ?? UNKNOWN;
}

/**
 * Split a full title string into a role title and, when present, the org-unit
 * division named alongside it (comma-delimited). Falls back to UNKNOWN division.
 */
function deriveTitleAndDivision(rawTitle: string | undefined): {
  title: Maybe<string>;
  division: Maybe<string>;
} {
  if (isBlank(rawTitle)) return { title: UNKNOWN, division: UNKNOWN };

  const segments = (rawTitle as string)
    .split(",")
    .map((s) => collapse(s))
    .filter((s) => s.length > 0);

  const divisionSegments = segments.filter((s) => DIVISION_CUES.test(s));
  const titleSegments = segments.filter((s) => !DIVISION_CUES.test(s));

  const division = divisionSegments.length > 0 ? divisionSegments.join(", ") : UNKNOWN;
  const title =
    titleSegments.length > 0 ? titleSegments.join(", ") : collapse(rawTitle as string);

  return { title, division };
}

/**
 * Extract the referring organization from the body. Recognizes common referral
 * phrasings and captures the capitalized organization name. Returns UNKNOWN
 * when no referral cue is present. For the Fixed_Lead this yields
 * "Anglo American" (Req 1.5).
 */
function deriveReferralSource(record: RawEmailRecord): Maybe<string> {
  const formReferral = record.formFields?.referralSource ?? record.formFields?.referral;
  if (!isBlank(formReferral)) return collapse(formReferral as string);

  const body = flatBody(record);
  const org = "[A-Z][\\w.&'-]*(?:\\s+[A-Z][\\w.&'-]*){0,4}";
  const patterns: RegExp[] = [
    new RegExp(`\\breferred (?:to (?:you|us) )?by\\s+(${org})`),
    new RegExp(`\\brecommended by\\s+(${org})`),
    new RegExp(`\\bat\\s+(${org})\\s+(?:recommended|referred|suggested|told me|pointed me)`),
    new RegExp(`\\b(${org})\\s+recommended\\s+(?:that\\s+)?(?:i|we|you)\\b`, "i"),
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]) {
      return collapse(match[1]);
    }
  }
  return UNKNOWN;
}

/**
 * Extract the stated timeline from the body. Prefers a sentence naming a fiscal
 * quarter (e.g. "Q3"), then falls back to other timing cues. Strips a leading
 * "On timing:"-style lead-in. Returns UNKNOWN when no timing signal is present.
 * For the Fixed_Lead this captures the Q3 internal budget conversation (Req 1.5).
 */
function deriveStatedTimeline(record: RawEmailRecord): Maybe<string> {
  const formTimeline = record.formFields?.timeline ?? record.formFields?.statedTimeline;
  if (!isBlank(formTimeline)) return collapse(formTimeline as string);

  const body = flatBody(record);
  if (body.length === 0) return UNKNOWN;

  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => collapse(s))
    .filter((s) => s.length > 0);

  const quarterCue = /\bQ[1-4]\b/;
  const timingCue =
    /\b(next\s+few\s+weeks|next\s+quarter|next\s+month|next\s+year|this\s+quarter|budget|timeline|timeframe|as\s+soon\s+as|by\s+end\s+of)\b/i;

  const chosen =
    sentences.find((s) => quarterCue.test(s)) ?? sentences.find((s) => timingCue.test(s));
  if (!chosen) return UNKNOWN;

  // Strip a conversational lead-in like "On timing:" / "Timing:" / "Timeline:".
  const stripped = chosen.replace(/^[^:]{0,24}:\s*/, (m) =>
    /timing|timeline|schedule/i.test(m) ? "" : m,
  );
  return collapse(stripped);
}

/**
 * Derive an explicit site count from the stated use case text / body, when one
 * is stated numerically or in words. Returns UNKNOWN when no count is stated.
 */
function deriveSiteCount(record: RawEmailRecord): Maybe<number> {
  const text = `${record.subject ?? ""} ${flatBody(record)}`;
  const noun = "(?:sites|locations|facilities|plants|mines|operations|assets|pads|substations)";

  const digitMatch = text.match(new RegExp(`\\b(\\d{1,5})\\s+${noun}\\b`, "i"));
  if (digitMatch && digitMatch[1]) {
    const n = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const wordAlt = Object.keys(NUMBER_WORDS).join("|");
  const wordMatch = text.match(new RegExp(`\\b(${wordAlt})\\s+${noun}\\b`, "i"));
  if (wordMatch && wordMatch[1]) {
    const n = NUMBER_WORDS[wordMatch[1].toLowerCase()];
    if (n !== undefined) return n;
  }

  return UNKNOWN;
}

/** Use the subject line as the stated use case; UNKNOWN when absent. */
function deriveStatedUseCase(record: RawEmailRecord): Maybe<string> {
  return isBlank(record.subject) ? UNKNOWN : collapse(record.subject);
}

/**
 * Infer the account's industry from generic vocabulary in the subject, body, and
 * contact-form fields. The label with the most distinct term hits wins; a tie or
 * zero hits yields `UNKNOWN` so nothing is invented (Req 1.4).
 *
 * A contact-form `industry` field, when supplied, always takes precedence over
 * inference.
 */
function deriveIndustry(record: RawEmailRecord): Maybe<string> {
  const stated = record.formFields?.industry;
  if (!isBlank(stated)) return collapse(stated as string);

  const haystack = `${record.subject ?? ""} ${flatBody(record)} ${Object.values(
    record.formFields ?? {},
  ).join(" ")}`.toLowerCase();
  if (haystack.trim().length === 0) return UNKNOWN;

  let best: string | undefined;
  let bestHits = 0;
  let tied = false;

  for (const [label, terms] of INDUSTRY_VOCABULARY) {
    let hits = 0;
    for (const term of terms) {
      // Word-bounded so "mine" does not match inside "determine".
      const pattern = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`);
      if (pattern.test(haystack)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = label;
      tied = false;
    } else if (hits === bestHits && hits > 0) {
      tied = true;
    }
  }

  if (best === undefined || bestHits === 0 || tied) return UNKNOWN;
  return best;
}

/** Build a stable, id-safe lead id from the best available identifier. */
function deriveLeadId(senderEmail: Maybe<string>, companyDomain: Maybe<string>): string {
  if (companyDomain !== UNKNOWN) return `lead_${slug(companyDomain)}`;
  if (senderEmail !== UNKNOWN) {
    const local = (senderEmail as string).split("@")[0] ?? senderEmail;
    return `lead_${slug(local)}`;
  }
  return "lead_unknown";
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Normalize a raw inbound email into a `LeadProfile`. Total (every field
 * populated or `"unknown"`) and lossless (`rawEmail` preserved verbatim).
 *
 * @param rawEmail the inbound contact-form email record
 * @param now injectable clock returning an ISO-8601 timestamp (defaults to
 *   `Date.now`), so callers and tests get deterministic `normalizedAt` values
 */
export function normalizeLead(
  rawEmail: RawEmailRecord,
  now: () => IsoTimestamp = () => new Date().toISOString(),
): LeadProfile {
  const senderName: Maybe<string> = isBlank(rawEmail.fromName)
    ? UNKNOWN
    : collapse(rawEmail.fromName);
  const senderEmail: Maybe<string> = isBlank(rawEmail.fromEmail)
    ? UNKNOWN
    : collapse(rawEmail.fromEmail).toLowerCase();

  const companyDomain: Maybe<string> =
    senderEmail === UNKNOWN ? UNKNOWN : deriveCompanyDomain(senderEmail);

  const company: Maybe<string> = isBlank(rawEmail.formFields?.company)
    ? UNKNOWN
    : collapse(rawEmail.formFields?.company as string);

  const { title, division } = deriveTitleAndDivision(rawEmail.formFields?.title);

  const country = deriveCountry(rawEmail);
  const region = deriveRegion(country);

  return {
    leadId: deriveLeadId(senderEmail, companyDomain),
    senderName,
    senderEmail,
    title,
    division,
    company,
    companyDomain,
    country,
    region,
    // Inferred from generic industry vocabulary in the email text (a contact-form
    // `industry` field wins when present). Feeds the highest-weighted Stage 4
    // rubric dimension; resolves to UNKNOWN when the text supports no single
    // label, so nothing is invented (Req 1.4).
    industry: deriveIndustry(rawEmail),
    statedUseCase: deriveStatedUseCase(rawEmail),
    statedPainPoints: [],
    referralSource: deriveReferralSource(rawEmail),
    statedTimeline: deriveStatedTimeline(rawEmail),
    siteCount: deriveSiteCount(rawEmail),
    rawEmail,
    normalizedAt: now(),
  };
}
