/**
 * Stage 2 — Researcher (`stage-2-researcher.ts`).
 *
 * This module owns the account-research stage. Four dimensions are researched,
 * each with at least one toolbelt call (Req 4.1):
 *   - `org_structure`        — reporting lines relevant to the lead's title/division (Req 4.2)
 *   - `budget_signals`       — investor-relations / annual-report / 20-F capex figures (Req 4.3)
 *   - `recent_news`          — regional automation and safety announcements (Req 4.4)
 *   - `leadership_language`  — investor / shareholder / earnings-call language (Req 4.5)
 * `positioning` is synthesized from the other four's claims, never searched.
 *
 * ---------------------------------------------------------------------------
 * SCOPE OF THIS FILE (task 8.1 — the DIMENSION RETRIEVAL LOOP)
 * ---------------------------------------------------------------------------
 * This file currently implements the retrieval half of the stage:
 *   1. Attribute-interpolated query templates built from `LeadProfile` fields
 *      ONLY (company, country, industry, title, division). Templates never
 *      contain company-specific string literals — the company name is
 *      interpolated in, and when an attribute is unknown it is simply omitted so
 *      a usable, generic query still results.
 *   2. For every searched dimension: issue >= 1 `toolbelt.search` (guaranteeing a
 *      ledger entry per dimension even when every request fails — Property 8),
 *      collect and dedupe the candidate hits, then `toolbelt.fetchPage` the top
 *      {@link TOP_HITS_PER_DIMENSION} (= 3) of them.
 *
 * The retrieval result is exposed through {@link retrieveDimensions} as a typed
 * {@link RetrievalByDimension} map. That map is the SEAM for task 8.2:
 *   - 8.2 (claim extraction + unknown fallback + positioning synthesis) consumes
 *     `RetrievalByDimension`, runs one LLM extraction call per dimension over the
 *     retrieved page text + URL, applies the zero-source `"unknown"` fallback
 *     (Req 4.8), stamps `retrievedAt` from the ledger (Req 4.9), and synthesizes
 *     the `positioningRecommendation` (Req 4.6).
 *   - See the clearly-marked `TODO(8.2)` block inside `run()` for exactly where
 *     that logic plugs in. Until then `run()` returns a minimal, schema-valid
 *     `ResearchReport` carrying only what the retrieval loop can know
 *     (`dimensionsWithNoSource`), so the stage is runnable end-to-end.
 */

import { z } from "zod";
import {
  UNKNOWN,
  type FetchedPage,
  type IsoTimestamp,
  type LeadProfile,
  type Maybe,
  type NumericFigure,
  type PositioningAssertion,
  type PositioningRecommendation,
  type ResearchClaim,
  type ResearchDimension,
  type ResearchReport,
  type SearchHit,
  type Stage,
  type StageContext,
} from "@/agent/contracts";
import { researchReportSchema } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Dimension set
// ---------------------------------------------------------------------------

/**
 * The four dimensions that are actively searched (Req 4.1). `positioning` is
 * deliberately excluded here: it is synthesized from these four in task 8.2,
 * never retrieved from the web.
 */
export type SearchedDimension = Exclude<ResearchDimension, "positioning">;

/** Canonical, deterministic order of the searched dimensions. */
export const SEARCHED_DIMENSIONS: readonly SearchedDimension[] = [
  "org_structure",
  "budget_signals",
  "recent_news",
  "leadership_language",
] as const;

/** All five dimensions, used when initializing full-coverage maps. */
export const ALL_DIMENSIONS: readonly ResearchDimension[] = [
  "org_structure",
  "budget_signals",
  "recent_news",
  "leadership_language",
  "positioning",
] as const;

/** Number of candidate hits fetched per dimension (the "top N", N = 3). */
export const TOP_HITS_PER_DIMENSION = 3;

/** Candidate hits requested per search query before dedupe/truncation. */
const SEARCH_MAX_RESULTS = 5;

// ---------------------------------------------------------------------------
// LeadProfile attribute helpers
// ---------------------------------------------------------------------------

/** True when a `Maybe<string>` carries a usable value (present and not the marker). */
function isKnown(value: Maybe<string>): value is string {
  return typeof value === "string" && value !== UNKNOWN && value.trim().length > 0;
}

/**
 * The only `LeadProfile` fields permitted to shape a query (Req 4.2–4.5). Kept
 * as a narrow struct so the query builders can never reach a company-specific
 * literal or any field outside this allow-list.
 */
interface QueryAttributes {
  company: Maybe<string>;
  country: Maybe<string>;
  industry: Maybe<string>;
  title: Maybe<string>;
  division: Maybe<string>;
}

function attributesOf(lead: LeadProfile): QueryAttributes {
  return {
    company: lead.company,
    country: lead.country,
    industry: lead.industry,
    title: lead.title,
    division: lead.division,
  };
}

/**
 * The search "subject": the account name when known, otherwise the industry, and
 * finally a neutral fallback so a dimension always yields at least one issuable
 * query (Property 8 requires a search attempt per dimension even for a
 * fully-unknown lead). The company name, when present, is quoted so the search
 * provider treats it as a phrase.
 */
function subjectPhrase(attrs: QueryAttributes): string {
  if (isKnown(attrs.company)) return `"${attrs.company}"`;
  if (isKnown(attrs.industry)) return attrs.industry;
  return "company";
}

/** Join non-empty query fragments into a single normalized query string. */
function composeQuery(...fragments: Array<string | false | null | undefined>): string {
  return fragments
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Attribute-interpolated query templates (Req 4.2–4.5)
// ---------------------------------------------------------------------------

/**
 * Build the attribute-interpolated query set for a single dimension. Every query
 * is composed from allow-listed `LeadProfile` attributes plus fixed thematic
 * keywords for the dimension; unknown attributes are omitted rather than
 * emitting the `"unknown"` marker into a query. At least one query is always
 * produced so the retrieval loop can guarantee a search attempt per dimension.
 */
export function buildDimensionQueries(
  dimension: SearchedDimension,
  attrs: QueryAttributes,
): string[] {
  const subject = subjectPhrase(attrs);
  const queries: string[] = [];

  switch (dimension) {
    // Req 4.2 — organizational structure and reporting lines relevant to the
    // lead's title and division.
    case "org_structure": {
      queries.push(
        composeQuery(subject, "organizational structure leadership team reporting lines"),
      );
      queries.push(
        composeQuery(
          subject,
          isKnown(attrs.division) && `${attrs.division} division`,
          isKnown(attrs.title) && `${attrs.title} reporting structure`,
          "who reports to",
        ),
      );
      break;
    }

    // Req 4.3 — budget signals from public financial disclosures: annual report /
    // 20-F capex, opex, technology investment, and the investor-relations page.
    case "budget_signals": {
      queries.push(
        composeQuery(subject, "investor relations annual report capital expenditure"),
      );
      queries.push(
        composeQuery(
          subject,
          "20-F capital expenditure operating expenditure technology investment",
        ),
      );
      break;
    }

    // Req 4.4 — news / press releases / strategic announcements covering the
    // account's stated operating region, automation, and safety.
    case "recent_news": {
      queries.push(
        composeQuery(
          subject,
          isKnown(attrs.country) && `${attrs.country} operations`,
          "automation safety announcement press release",
        ),
      );
      queries.push(
        composeQuery(
          subject,
          isKnown(attrs.country) && attrs.country,
          "strategic announcement news automation initiative",
        ),
      );
      break;
    }

    // Req 4.5 — leadership language from investor / shareholder letters and
    // earnings-call material that reveals operational priorities.
    case "leadership_language": {
      queries.push(
        composeQuery(subject, "shareholder letter operational priorities strategy"),
      );
      queries.push(
        composeQuery(subject, "earnings call transcript CEO priorities investor letter"),
      );
      break;
    }
  }

  // Drop empties and duplicates while preserving order; guarantee >= 1 query.
  const deduped = dedupeStrings(queries.filter((q) => q.length > 0));
  if (deduped.length === 0) {
    deduped.push(composeQuery(subject, dimension.replace(/_/g, " ")));
  }
  return deduped;
}

/**
 * Build the full query set for every searched dimension from a `LeadProfile`.
 * Exposed so task 8.2 and unit tests can inspect the exact queries issued.
 */
export function buildAllDimensionQueries(
  lead: LeadProfile,
): Record<SearchedDimension, string[]> {
  const attrs = attributesOf(lead);
  return {
    org_structure: buildDimensionQueries("org_structure", attrs),
    budget_signals: buildDimensionQueries("budget_signals", attrs),
    recent_news: buildDimensionQueries("recent_news", attrs),
    leadership_language: buildDimensionQueries("leadership_language", attrs),
  };
}

// ---------------------------------------------------------------------------
// Retrieval result — the SEAM consumed by task 8.2
// ---------------------------------------------------------------------------

/** Everything the retrieval loop gathered for one dimension. */
export interface DimensionRetrieval {
  dimension: SearchedDimension;
  /** The attribute-interpolated queries that were issued via `toolbelt.search`. */
  queries: string[];
  /** Deduped candidate hits across all queries, in discovery order. */
  hits: SearchHit[];
  /** Successfully fetched top-N pages (text + final URL); may be empty. */
  pages: FetchedPage[];
}

/** Retrieval results keyed by searched dimension. Task 8.2 turns this into claims. */
export type RetrievalByDimension = Record<SearchedDimension, DimensionRetrieval>;

// ---------------------------------------------------------------------------
// URL dedupe helpers
// ---------------------------------------------------------------------------

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Light normalization for de-duplicating candidate URLs before fetching. The
 * toolbelt/ledger performs the authoritative normalization for provenance; this
 * pass only prevents fetching the same page twice within a dimension.
 */
function normalizeUrlForDedupe(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** Collect valid, deduped candidate URLs from a set of hits, in order. */
function candidateUrls(hits: readonly SearchHit[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const hit of hits) {
    const raw = hit?.url;
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    if (!/^https?:\/\//i.test(raw)) continue;
    const key = normalizeUrlForDedupe(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(raw);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// The dimension retrieval loop (Req 4.1)
// ---------------------------------------------------------------------------

/**
 * Execute the retrieval loop for all four searched dimensions.
 *
 * For each dimension, in {@link SEARCHED_DIMENSIONS} order:
 *   1. Build attribute-interpolated queries from the lead profile.
 *   2. Issue every query via `toolbelt.search` — this guarantees at least one
 *      toolbelt request (and therefore at least one ledger entry) per dimension,
 *      even when every request degrades to an empty result (Req 4.1, Property 8).
 *   3. Dedupe the candidate URLs and `fetchPage` the top {@link TOP_HITS_PER_DIMENSION}.
 *
 * The toolbelt never throws (it degrades to `[]` / `null`), so this loop needs no
 * try/catch — a failed search simply yields no hits and a failed fetch is skipped.
 */
export async function retrieveDimensions(ctx: StageContext): Promise<RetrievalByDimension> {
  const { toolbelt, leadProfile } = ctx;
  const attrs = attributesOf(leadProfile);

  const results = {} as RetrievalByDimension;

  for (const dimension of SEARCHED_DIMENSIONS) {
    const queries = buildDimensionQueries(dimension, attrs);

    ctx.emit({
      stage: 2,
      stageName: "Researcher",
      type: "reasoning",
      message: `Researching ${dimension}: ${queries.length} query template(s)`,
    });

    // 1..N searches per dimension (>= 1 guaranteed by buildDimensionQueries).
    const hits: SearchHit[] = [];
    for (const query of queries) {
      const queryHits = await toolbelt.search(query, { maxResults: SEARCH_MAX_RESULTS });
      hits.push(...queryHits);
    }

    // Dedupe candidate URLs and fetch the top N.
    const urls = candidateUrls(hits).slice(0, TOP_HITS_PER_DIMENSION);
    const pages: FetchedPage[] = [];
    for (const url of urls) {
      const page = await toolbelt.fetchPage(url);
      if (page) pages.push(page);
    }

    ctx.emit({
      stage: 2,
      stageName: "Researcher",
      type: "reasoning",
      message: `Dimension ${dimension}: ${hits.length} hit(s), ${pages.length} page(s) fetched`,
    });

    results[dimension] = { dimension, queries, hits, pages };
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-dimension claim-id map helper
// ---------------------------------------------------------------------------

/** An empty per-dimension claim-id map covering all five dimensions. */
function emptyClaimsByDimension(): Record<ResearchDimension, string[]> {
  const map = {} as Record<ResearchDimension, string[]>;
  for (const dimension of ALL_DIMENSIONS) {
    map[dimension] = [];
  }
  return map;
}

// ---------------------------------------------------------------------------
// Task 8.2 — claim extraction (one LLM call per dimension)
// ---------------------------------------------------------------------------

/**
 * The shape a single dimension's extraction call is constrained to. The model
 * sees ONLY retrieved page text plus each page's URL and returns atomic claims,
 * each carrying the exact `sourceUrl` it was drawn from, a `supportingQuote`
 * span copied verbatim from that source, and any `numericFigures` found in the
 * text. `sourceUrl`/`retrievedAt`/`verificationStatus` on the final
 * {@link ResearchClaim} are NOT trusted to the model — `sourceUrl` is resolved
 * against the dimension's fetched pages and `retrievedAt` is stamped from the
 * ledger-backed {@link FetchedPage} (Req 4.9).
 */
const claimExtractionDraftSchema = z.object({
  claims: z
    .array(
      z.object({
        claimText: z.string(),
        sourceUrl: z.string(),
        supportingQuote: z.string(),
        numericFigures: z
          .array(z.object({ label: z.string(), value: z.string() }))
          .default([]),
      }),
    )
    .default([]),
});

/**
 * The shape the positioning-synthesis call is constrained to. Assertions may
 * come back citing anything; the stage keeps only the `supportingClaimIds` that
 * resolve to a real emitted claim id and drops assertions left with none
 * (Req 4.6).
 */
const positioningDraftSchema = z.object({
  narrative: z.string(),
  assertions: z
    .array(
      z.object({
        assertion: z.string(),
        supportingClaimIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

/** Human-readable description of what each dimension is about, for the prompt. */
const DIMENSION_BRIEF: Record<SearchedDimension, string> = {
  org_structure:
    "organizational structure and reporting lines relevant to the lead's title and division",
  budget_signals:
    "budget signals from public financial disclosures: annual-report / 20-F capital " +
    "expenditure, operating expenditure, or technology-investment figures",
  recent_news:
    "news, press releases, or strategic announcements about the account covering its " +
    "operating region, automation, and safety",
  leadership_language:
    "leadership language from investor letters, shareholder letters, or earnings-call " +
    "material that reveals operational priorities",
};

/** Only pages that actually carry readable text can support a claim. */
function pagesWithText(pages: readonly FetchedPage[]): FetchedPage[] {
  return pages.filter((p) => typeof p.text === "string" && p.text.trim().length > 0);
}

/** Normalized (whitespace-collapsed, lower-cased) text for span/URL matching. */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Build the single unknown claim emitted for a dimension with no usable source (Req 4.8). */
function unknownClaim(dimension: SearchedDimension): ResearchClaim {
  return {
    claimId: `claim_${dimension}_1`,
    dimension,
    claimText: UNKNOWN,
    sourceUrl: UNKNOWN,
    supportingQuote: UNKNOWN,
    retrievedAt: UNKNOWN,
    verificationStatus: "unknown",
    numericFigures: [],
  };
}

/**
 * Run ONE extraction LLM call over a dimension's fetched pages and return the
 * verified claims it yields. Degrades to an empty array (never throws) on any
 * LLM/validation failure — the caller substitutes the unknown claim. Every
 * returned claim has a `sourceUrl` that resolves to one of the fetched pages,
 * a non-empty `supportingQuote` found in that page's text, and `retrievedAt`
 * copied from the ledger-backed page (Req 4.7, 4.9).
 */
async function extractClaimsForDimension(
  ctx: StageContext,
  dimension: SearchedDimension,
  pages: readonly FetchedPage[],
): Promise<ResearchClaim[]> {
  const usable = pagesWithText(pages);
  if (usable.length === 0) return [];

  // Resolution index: normalized final/requested URL -> canonical page.
  const pageByUrl = new Map<string, FetchedPage>();
  for (const page of usable) {
    pageByUrl.set(normalizeUrlForDedupe(page.finalUrl), page);
    pageByUrl.set(normalizeUrlForDedupe(page.requestedUrl), page);
  }

  // The prompt contains ONLY retrieved text plus each page's URL (Req 4.6/4.7).
  const sourcesBlock = usable
    .map(
      (page, i) =>
        `SOURCE ${i + 1}\nurl: ${page.finalUrl}\ntext:\n${page.text}`,
    )
    .join("\n\n---\n\n");

  const systemPrompt = [
    "You extract atomic, verifiable factual claims from retrieved web page text.",
    `Focus on ${DIMENSION_BRIEF[dimension]}.`,
    "",
    "Rules you MUST follow:",
    "- Extract a claim ONLY if it is explicitly supported by the provided text.",
    "- For each claim set sourceUrl to EXACTLY one of the provided source urls.",
    "- Set supportingQuote to a verbatim span copied from that source's text.",
    "- List every numeric figure (label + value, keep units) that appears in the",
    "  supporting text; use an empty array when there are none.",
    "- Do NOT invent, infer, or generalize beyond the text. If nothing is",
    "  supported, return an empty claims array.",
  ].join("\n");

  const userPrompt = [
    `Research dimension: ${dimension}`,
    "",
    "Retrieved sources:",
    sourcesBlock,
  ].join("\n");

  let draft: z.infer<typeof claimExtractionDraftSchema>;
  try {
    const result = await ctx.llm.completeJson({
      purpose: `stage-2-extract-${dimension}`,
      systemPrompt,
      userPrompt,
      schema: claimExtractionDraftSchema,
      temperature: 0.1,
    });
    draft = result.value;
  } catch (error) {
    // Extraction must degrade, never throw (Req 17.x). The caller emits the
    // unknown claim for this dimension.
    ctx.emit({
      stage: 2,
      stageName: "Researcher",
      type: "reasoning",
      message: `Extraction for ${dimension} failed; substituting unknown claim (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    });
    return [];
  }

  const claims: ResearchClaim[] = [];
  let n = 0;
  for (const raw of draft.claims) {
    // Resolve the model's sourceUrl against the fetched pages; drop if it does
    // not correspond to a page we actually retrieved this run.
    const page = pageByUrl.get(normalizeUrlForDedupe(raw.sourceUrl));
    if (!page) continue;

    // Require a real supporting span that actually appears in the source text.
    const quote = raw.supportingQuote?.trim() ?? "";
    if (quote.length === 0) continue;
    if (!normalizeForMatch(page.text).includes(normalizeForMatch(quote))) continue;

    n += 1;
    const claimId = `claim_${dimension}_${n}`;
    // Numeric figures carry their own sourceUrl — the resolved, ledgered page
    // URL the figure was read from (Req 5.6).
    const numericFigures: NumericFigure[] = raw.numericFigures.map((fig) => ({
      label: fig.label,
      value: fig.value,
      sourceUrl: page.finalUrl,
    }));

    claims.push({
      claimId,
      dimension,
      claimText: raw.claimText,
      sourceUrl: page.finalUrl,
      supportingQuote: quote,
      retrievedAt: page.retrievedAt as IsoTimestamp,
      verificationStatus: "verified",
      numericFigures,
    });
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Task 8.2 — positioning synthesis (Req 4.6)
// ---------------------------------------------------------------------------

/**
 * Synthesize the {@link PositioningRecommendation} from the verified claims.
 * Every surviving assertion cites >= 1 `supportingClaimId` that resolves to a
 * real emitted claim id; assertions left with no resolvable id are dropped
 * (Req 4.6). Degrades to an empty, `"unknown"`-narrative recommendation when
 * there are no verified claims or the synthesis call fails.
 */
async function synthesizePositioning(
  ctx: StageContext,
  verifiedClaims: readonly ResearchClaim[],
  validClaimIds: ReadonlySet<string>,
): Promise<PositioningRecommendation> {
  if (verifiedClaims.length === 0) {
    return { narrative: UNKNOWN, assertions: [] };
  }

  const claimsBlock = verifiedClaims
    .map((c) => `- ${c.claimId} [${c.dimension}]: ${c.claimText}`)
    .join("\n");

  const systemPrompt = [
    "You synthesize how FlytBase should position to an account, grounded ONLY in",
    "the verified research claims provided.",
    "",
    "Rules you MUST follow:",
    "- Write a concise narrative recommendation.",
    "- Produce assertions that each cite at least one supportingClaimId drawn",
    "  from the provided claim id list. Do NOT cite ids that are not listed.",
    "- Do NOT introduce facts that are not supported by the listed claims.",
  ].join("\n");

  const userPrompt = ["Verified research claims:", claimsBlock].join("\n");

  let draft: z.infer<typeof positioningDraftSchema>;
  try {
    const result = await ctx.llm.completeJson({
      purpose: "stage-2-positioning",
      systemPrompt,
      userPrompt,
      schema: positioningDraftSchema,
      temperature: 0.2,
    });
    draft = result.value;
  } catch (error) {
    ctx.emit({
      stage: 2,
      stageName: "Researcher",
      type: "reasoning",
      message: `Positioning synthesis failed; emitting no assertions (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    });
    return { narrative: UNKNOWN, assertions: [] };
  }

  // Keep only assertions whose citations resolve to real emitted claim ids
  // (Req 4.6); drop any assertion left with zero resolvable ids.
  const assertions: PositioningAssertion[] = [];
  for (const raw of draft.assertions) {
    const resolved = dedupeStrings(
      raw.supportingClaimIds.filter((id) => validClaimIds.has(id)),
    );
    if (resolved.length === 0) continue;
    assertions.push({ assertion: raw.assertion, supportingClaimIds: resolved });
  }

  const narrative =
    typeof draft.narrative === "string" && draft.narrative.trim().length > 0
      ? draft.narrative
      : UNKNOWN;

  return { narrative, assertions };
}

// ---------------------------------------------------------------------------
// Stage module (Req 13.5)
// ---------------------------------------------------------------------------

export const stage2Researcher: Stage<ResearchReport> = {
  stage: 2,
  stageName: "Researcher",
  sourceFile: "src/agent/stages/stage-2-researcher.ts",
  dependsOn: ["qualification"],
  usesToolbelt: true,
  schema: researchReportSchema,

  async run(ctx: StageContext): Promise<ResearchReport> {
    // --- Task 8.1: dimension retrieval loop -------------------------------
    const retrieval = await retrieveDimensions(ctx);

    // --- Task 8.2: claim extraction, unknown fallback, positioning --------
    const claims: ResearchClaim[] = [];
    const claimsByDimension = emptyClaimsByDimension();
    const dimensionsWithNoSource: ResearchDimension[] = [];

    // One extraction LLM call per searched dimension over its fetched page text
    // + URL. A dimension with zero usable source (nothing fetched, or the call
    // degraded, or no verifiable claim survived) yields EXACTLY one unknown
    // claim and is recorded in dimensionsWithNoSource (Req 4.8).
    for (const dimension of SEARCHED_DIMENSIONS) {
      const extracted = await extractClaimsForDimension(
        ctx,
        dimension,
        retrieval[dimension].pages,
      );

      if (extracted.length === 0) {
        const claim = unknownClaim(dimension);
        claims.push(claim);
        claimsByDimension[dimension] = [claim.claimId];
        dimensionsWithNoSource.push(dimension);
        continue;
      }

      claims.push(...extracted);
      claimsByDimension[dimension] = extracted.map((c) => c.claimId);
    }

    const verifiedClaims = claims.filter((c) => c.verificationStatus === "verified");
    const verifiedClaimCount = verifiedClaims.length;

    // Positioning is synthesized (never searched). Every assertion must cite a
    // claim id that resolves to a real emitted claim (Req 4.6).
    const validClaimIds = new Set(claims.map((c) => c.claimId));
    const positioningRecommendation = await synthesizePositioning(
      ctx,
      verifiedClaims,
      validClaimIds,
    );

    ctx.emit({
      stage: 2,
      stageName: "Researcher",
      type: "reasoning",
      message:
        `Extracted ${claims.length} claim(s) (${verifiedClaimCount} verified); ` +
        `${dimensionsWithNoSource.length} dimension(s) with no source; ` +
        `${positioningRecommendation.assertions.length} positioning assertion(s).`,
    });

    const report: ResearchReport = {
      claims,
      claimsByDimension,
      positioningRecommendation,
      dimensionsWithNoSource,
      verifiedClaimCount,
    };

    return report;
  },
};

export default stage2Researcher;
