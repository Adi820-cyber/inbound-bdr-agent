/**
 * Case-study URL enumeration (Req 7.1, Property 18).
 *
 * Stage 4 discovers the FlytBase case-study library at runtime rather than
 * reading a hardcoded lookup table. The first step is enumeration: fetch the
 * case-studies index page and extract the URLs of the individual case-study
 * pages it links to.
 *
 * The enumeration core, {@link enumerateCaseStudyUrls}, is a PURE function of
 * `(html, baseUrl, maxPages)` so it is exhaustively testable (Property 18)
 * without any network. It:
 *   - extracts anchor `href` values from raw HTML with a tolerant regex,
 *   - resolves relative (`/case-studies/foo`) and protocol-relative
 *     (`//host/path`) hrefs against the index URL,
 *   - filters to same-origin case-study *page* paths (dropping the index
 *     itself, off-origin links, and fragment-only / non-http links),
 *   - dedupes after URL normalization (see `normalizeUrl`),
 *   - caps the result at `maxPages` (`CRAWL_MAX_PAGES`),
 *   - and NEVER throws — malformed markup and adversarial URL shapes degrade to
 *     "skip this href", never to an exception.
 *
 * IMPORTANT — why this takes raw HTML, not a `FetchedPage`:
 * the Research Toolbelt reduces every page to readable text via
 * `extractReadableText`, which strips `<a>` tags and their hrefs. Readable text
 * is the right input for LLM extraction but useless for URL enumeration, which
 * needs the raw anchors. The pure function therefore takes a raw HTML string,
 * and the async wrapper below takes an injected raw-HTML fetcher rather than the
 * toolbelt's text-returning `fetchPage`.
 */

import { z } from "zod";

import {
  UNKNOWN,
  type CaseStudyRecord,
  type FetchedPage,
  type LlmProvider,
  type Maybe,
  type ResearchToolbelt,
  type StageNumber,
} from "@/agent/contracts";
import { normalizeUrl } from "@/research/fetch-ledger";
import type { ToolbeltEmit } from "@/research/toolbelt";
import { getConfig } from "@/lib/config/env";

// ---------------------------------------------------------------------------
// Anchor extraction
// ---------------------------------------------------------------------------

/**
 * Matches an opening `<a>` tag and captures its `href` value in one of three
 * forms: double-quoted, single-quoted, or unquoted. Deliberately permissive so
 * malformed markup still yields whatever hrefs it can — the regex only ever
 * *matches less*, it never throws.
 */
const ANCHOR_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

/** Schemes that never point at a fetchable case-study page. */
const NON_HTTP_SCHEME_RE = /^(?:javascript|mailto|tel|data|blob|file|ftp):/i;

/**
 * A case-study *page* path: `/case-study/<slug>` or `/case-studies/<slug>` with
 * a non-empty slug. This excludes the index page itself (`/case-studies`) and a
 * bare trailing slash (`/case-studies/`). Case-insensitive.
 */
const CASE_STUDY_PATH_RE = /^\/case-stud(?:y|ies)\/[^/].*/i;

/**
 * Extract every anchor `href` from raw HTML. Returns the raw, unresolved href
 * strings in document order (including duplicates). Never throws; on any
 * unexpected input it returns whatever it has matched so far (or an empty list).
 */
export function extractAnchorHrefs(html: string): string[] {
  const hrefs: string[] = [];
  if (typeof html !== "string" || html.length === 0) return hrefs;

  try {
    // Reset lastIndex defensively — the regex is module-scoped and global.
    ANCHOR_HREF_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ANCHOR_HREF_RE.exec(html)) !== null) {
      // Guard against a zero-width match causing an infinite loop.
      if (match.index === ANCHOR_HREF_RE.lastIndex) {
        ANCHOR_HREF_RE.lastIndex += 1;
      }
      const raw = match[1] ?? match[2] ?? match[3];
      if (typeof raw === "string") {
        const href = raw.trim();
        if (href.length > 0) hrefs.push(href);
      }
    }
  } catch {
    // Extremely defensive: return whatever was collected before the fault.
    return hrefs;
  }

  return hrefs;
}

// ---------------------------------------------------------------------------
// Same-origin case-study filtering
// ---------------------------------------------------------------------------

/** True when `candidate` shares protocol, host, and port with `base`. */
function isSameOrigin(candidate: URL, base: URL): boolean {
  return candidate.origin === base.origin && candidate.protocol === base.protocol;
}

/** True when the pathname identifies a case-study page (not the index itself). */
function isCaseStudyPath(pathname: string): boolean {
  return CASE_STUDY_PATH_RE.test(pathname);
}

/**
 * Resolve a single href against the index URL and return an absolute URL when
 * it is a same-origin, http(s), case-study page; otherwise `null`. Never throws.
 */
function resolveCaseStudyUrl(href: string, base: URL): URL | null {
  if (NON_HTTP_SCHEME_RE.test(href)) return null;

  let resolved: URL;
  try {
    // The URL constructor resolves relative and protocol-relative hrefs
    // (`//host/path` inherits the base protocol) against `base`.
    resolved = new URL(href, base);
  } catch {
    return null;
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  if (!isSameOrigin(resolved, base)) return null;
  if (!isCaseStudyPath(resolved.pathname)) return null;

  return resolved;
}

// ---------------------------------------------------------------------------
// Pure enumeration core (Property 18)
// ---------------------------------------------------------------------------

/**
 * Enumerate the same-origin case-study page URLs linked from an index page.
 *
 * PURE and TOTAL: for ANY inputs — malformed markup, relative and
 * protocol-relative hrefs, duplicate links, fragment-only links, off-origin
 * links, adversarial URL shapes — it returns only absolute same-origin
 * case-study URLs, contains no duplicates after normalization, never exceeds
 * `maxPages`, and never throws.
 *
 * @param html     Raw HTML of the case-studies index page (NOT stripped text).
 * @param baseUrl  The index page URL, used to resolve relative hrefs and to
 *                 define the same-origin boundary.
 * @param maxPages Hard cap on the number of URLs returned (`CRAWL_MAX_PAGES`).
 * @returns        Absolute case-study URLs, deduped after normalization, in
 *                 first-seen document order, capped at `maxPages`.
 */
export function enumerateCaseStudyUrls(
  html: string,
  baseUrl: string,
  maxPages: number,
): string[] {
  // A non-positive or non-finite cap yields nothing to crawl.
  const cap = Number.isFinite(maxPages) ? Math.max(0, Math.floor(maxPages)) : 0;
  if (cap === 0) return [];

  // An unusable base URL means nothing can be resolved same-origin.
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const href of extractAnchorHrefs(html)) {
    const resolved = resolveCaseStudyUrl(href, base);
    if (resolved === null) continue;

    const absolute = resolved.toString();
    const key = normalizeUrl(absolute);
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(absolute);
    if (result.length >= cap) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Async index-fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Fetches the case-studies index as RAW HTML and enumerates its case-study
 * URLs. The raw-HTML fetcher is injected because the Research Toolbelt's
 * `fetchPage` returns readability-stripped text with the anchors already
 * removed; enumeration needs the raw markup. A fetcher that returns `null`
 * (network failure, non-2xx, timeout — the toolbelt's degradation contract)
 * yields an empty enumeration rather than an error, so the caller can fall
 * through to the cached-corpus chain (task 11.7).
 *
 * @param indexUrl     The FlytBase case-studies index URL.
 * @param fetchRawHtml Raw-HTML fetcher; returns `null` on any failure.
 * @param maxPages     Optional cap; defaults to `CRAWL_MAX_PAGES` from config.
 */
export async function fetchAndEnumerateCaseStudyUrls(
  indexUrl: string,
  fetchRawHtml: (url: string) => Promise<string | null>,
  maxPages?: number,
): Promise<string[]> {
  const cap = maxPages ?? getConfig().crawlMaxPages;

  let html: string | null;
  try {
    html = await fetchRawHtml(indexUrl);
  } catch {
    // The fetcher is expected to degrade, not throw; guard anyway.
    return [];
  }
  if (typeof html !== "string" || html.length === 0) return [];

  return enumerateCaseStudyUrls(html, indexUrl, cap);
}

// ---------------------------------------------------------------------------
// Per-page case-study extraction (Req 7.2, 7.3, 7.8; Property 19)
// ---------------------------------------------------------------------------

/**
 * The extraction step turns each enumerated case-study *page* into one
 * {@link CaseStudyRecord}. Unlike enumeration (which needs raw anchors), this
 * step consumes the Research Toolbelt's readability-stripped page text, which
 * is exactly the right input for an LLM: one `completeJson` call per page reads
 * the readable text and returns the six extractable content fields.
 *
 * Three fields are NEVER taken from the model, because they are provenance, not
 * content:
 *   - `sourceUrl` is the page URL we requested,
 *   - `retrievedAt` comes from the {@link FetchedPage} (i.e. the ledger), and
 *   - `verificationStatus` is `"verified"` for a live fetch (`"stale"` when the
 *     page came from the cached corpus).
 *
 * Extraction is TOTAL (Property 19): a fetch failure (`fetchPage` → `null`), an
 * LLM validation failure, or any thrown error yields a fully-populated record
 * whose content fields are the literal `"unknown"` — never a throw, never a
 * missing field. Every field of the returned record is therefore present and is
 * either a non-empty value or exactly `"unknown"` (Req 7.3).
 *
 * Every page request emits one StageEvent carrying the requested URL and the
 * response status (Req 7.8), so the run trace records the crawl exhaustively.
 */

/**
 * The six content fields an LLM extracts from a case-study page. `sourceUrl`,
 * `retrievedAt`, and `verificationStatus` are provenance and are set by the
 * caller, never by the model, so they are deliberately absent here.
 *
 * Each field is `string | "unknown"`; the caller further normalizes empty /
 * whitespace-only strings to `"unknown"` so Property 19's "non-empty value or
 * exactly 'unknown'" invariant holds regardless of what the model returns.
 */
const maybeStringField = z.union([z.string(), z.literal("unknown")]);

export const caseStudyExtractionSchema = z.object({
  title: maybeStringField,
  industry: maybeStringField,
  region: maybeStringField,
  useCase: maybeStringField,
  namedPartner: maybeStringField,
  statedResults: maybeStringField,
});

export type CaseStudyExtractionFields = z.infer<typeof caseStudyExtractionSchema>;

/** Stage attribution for emitted page-request events. Defaults to Stage 4. */
const DEFAULT_STAGE_INFO: { stage: StageNumber; stageName: string } = {
  stage: 4,
  stageName: "Matcher",
};

/** Collaborators for the per-page extraction loop. All network/LLM access is injected. */
export interface CaseStudyExtractionDeps {
  /** The Research Toolbelt (only `fetchPage` is used here). */
  toolbelt: Pick<ResearchToolbelt, "fetchPage">;
  /** The LLM provider; one `completeJson` call is made per fetched page. */
  llm: LlmProvider;
  /** Emits one page-request StageEvent per URL (Req 7.8). */
  emit: ToolbeltEmit;
  /** Stage attribution for the emitted events. Defaults to Stage 4 (Matcher). */
  stageInfo?: { stage: StageNumber; stageName: string };
  /** Clock override for deterministic event timestamps in tests. Defaults to `new Date()`. */
  now?: () => Date;
  /** Output-token ceiling for the extraction call. */
  maxOutputTokens?: number;
  /** Sampling temperature for the extraction call. Defaults to 0 for stable extraction. */
  temperature?: number;
}

/**
 * Normalize a single extracted field to the Property-19 shape: a non-empty
 * value or exactly `"unknown"`. Trims surrounding whitespace; any empty result
 * (or the literal `"unknown"`) collapses to `UNKNOWN`.
 */
function normalizeField(value: Maybe<string> | undefined): Maybe<string> {
  if (typeof value !== "string") return UNKNOWN;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === UNKNOWN) return UNKNOWN;
  return trimmed;
}

/** Build an all-`"unknown"` record for `sourceUrl` — the extraction-failure shape. */
function unknownRecord(
  sourceUrl: string,
  retrievedAt: Maybe<string>,
  verificationStatus: CaseStudyRecord["verificationStatus"],
): CaseStudyRecord {
  return {
    sourceUrl,
    title: UNKNOWN,
    industry: UNKNOWN,
    region: UNKNOWN,
    useCase: UNKNOWN,
    namedPartner: UNKNOWN,
    statedResults: UNKNOWN,
    verificationStatus,
    retrievedAt,
  };
}

/**
 * Build the extraction prompt for one case-study page. Pure and deterministic.
 * The system prompt fixes the anti-fabrication contract (emit `"unknown"` for
 * anything not literally present); the user prompt carries the page URL and its
 * readable text.
 */
export function buildCaseStudyExtractionPrompt(
  sourceUrl: string,
  pageText: string,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt =
    "You extract structured facts from a single FlytBase case-study web page. " +
    "Return only these six fields: title, industry, region, useCase, namedPartner, statedResults. " +
    "Use the page's own words; do not infer, guess, or fabricate. " +
    'If a field is not clearly present on the page, set it to the exact string "unknown". ' +
    "Never invent a value to fill a field.\n" +
    "Field meanings: title = the case study's headline; industry = the customer's industry; " +
    "region = the geography where the deployment took place; useCase = the operational use case " +
    "(what the drones/software did); namedPartner = any named integration, channel, or service " +
    "partner; statedResults = the outcomes or metrics the page reports.";

  const userPrompt =
    `Case-study page URL: ${sourceUrl}\n\n` +
    "Extract the six fields from the page text below. " +
    'Any field absent from the text must be exactly "unknown".\n\n' +
    "--- BEGIN PAGE TEXT ---\n" +
    pageText +
    "\n--- END PAGE TEXT ---";

  return { systemPrompt, userPrompt };
}

/**
 * Run ONE LLM extraction over already-retrieved page text and assemble a
 * {@link CaseStudyRecord}. TOTAL: any extraction failure (LLM validation error,
 * transport error, or malformed value) degrades to an all-`"unknown"` record
 * rather than throwing (Property 19). Provenance fields are supplied by the
 * caller and are never overwritten by the model.
 */
export async function extractCaseStudyFromText(args: {
  sourceUrl: string;
  pageText: string;
  retrievedAt: Maybe<string>;
  verificationStatus: CaseStudyRecord["verificationStatus"];
  llm: LlmProvider;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<CaseStudyRecord> {
  const { sourceUrl, pageText, retrievedAt, verificationStatus, llm } = args;
  const { systemPrompt, userPrompt } = buildCaseStudyExtractionPrompt(sourceUrl, pageText);

  try {
    const { value } = await llm.completeJson<CaseStudyExtractionFields>({
      purpose: "stage4_case_study_extraction",
      systemPrompt,
      userPrompt,
      schema: caseStudyExtractionSchema,
      maxOutputTokens: args.maxOutputTokens,
      temperature: args.temperature ?? 0,
    });

    return {
      sourceUrl,
      title: normalizeField(value.title),
      industry: normalizeField(value.industry),
      region: normalizeField(value.region),
      useCase: normalizeField(value.useCase),
      namedPartner: normalizeField(value.namedPartner),
      statedResults: normalizeField(value.statedResults),
      verificationStatus,
      retrievedAt,
    };
  } catch {
    // Extraction failure is a degradation path, not an exception (Property 19).
    return unknownRecord(sourceUrl, retrievedAt, verificationStatus);
  }
}

/**
 * Fetch each enumerated case-study page and extract one {@link CaseStudyRecord}
 * per page. For every URL this:
 *   1. fetches the page via `toolbelt.fetchPage` (returns `FetchedPage | null`),
 *   2. emits a StageEvent carrying the requested URL and response status (Req 7.8),
 *   3. runs one LLM extraction into a record whose provenance fields come from
 *      the fetched page / ledger, not the model.
 *
 * TOTAL: a `null` fetch (network failure, non-2xx, timeout — the toolbelt's
 * degradation contract) still yields a record with `"unknown"` content fields,
 * `verificationStatus: "unknown"`, and `retrievedAt: "unknown"`, so the returned
 * array has exactly one record per input URL and this function never throws.
 */
export async function extractCaseStudiesFromPages(
  urls: readonly string[],
  deps: CaseStudyExtractionDeps,
): Promise<CaseStudyRecord[]> {
  const { toolbelt, llm, emit } = deps;
  const stageInfo = deps.stageInfo ?? DEFAULT_STAGE_INFO;
  const now = deps.now ?? (() => new Date());

  const records: CaseStudyRecord[] = [];

  for (const url of urls) {
    let page: FetchedPage | null;
    try {
      page = await toolbelt.fetchPage(url);
    } catch {
      // The toolbelt is designed to degrade, not throw; guard defensively so a
      // single misbehaving fetch cannot abort the whole crawl.
      page = null;
    }

    if (page === null) {
      const retrievedAt = now().toISOString();
      emit({
        stage: stageInfo.stage,
        stageName: stageInfo.stageName,
        type: "tool_error",
        message: `Case-study page fetch failed: ${url}`,
        toolCall: {
          kind: "page_fetch",
          urlOrQuery: url,
          statusCode: UNKNOWN,
          retrievedAt,
        },
      });
      records.push(unknownRecord(url, UNKNOWN, "unknown"));
      continue;
    }

    emit({
      stage: stageInfo.stage,
      stageName: stageInfo.stageName,
      type: "tool_call",
      message: `Fetched case-study page ${url} (status ${page.statusCode})`,
      toolCall: {
        kind: "page_fetch",
        urlOrQuery: url,
        statusCode: page.statusCode,
        retrievedAt: page.retrievedAt,
      },
    });

    const record = await extractCaseStudyFromText({
      sourceUrl: url,
      pageText: page.text,
      retrievedAt: page.retrievedAt,
      verificationStatus: page.fromCache ? "stale" : "verified",
      llm,
      maxOutputTokens: deps.maxOutputTokens,
      temperature: deps.temperature,
    });

    records.push(record);
  }

  return records;
}
