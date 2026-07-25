/**
 * Research Toolbelt — the SOLE web egress point (Req 13.3, 13.4).
 *
 * Every outbound search and page fetch in the entire application funnels
 * through this module. Nothing else is permitted to touch the network; a lint
 * rule confines `fetch`/`axios` imports to `src/research/` and `src/providers/`.
 *
 * The toolbelt is a *degrading* service, never a throwing one (Req 17.1, 17.2):
 *  - A per-request `AbortController` enforces `REQUEST_TIMEOUT_MS`. On timeout,
 *    the request is aborted, a `tool_error` StageEvent is emitted, and the call
 *    returns `null` (fetchPage) / `[]` (search) instead of throwing.
 *  - A non-success (non-2xx) status, a network failure, or a parse failure is
 *    handled identically: append a ledger entry, emit a `tool_error`, return
 *    empty/null. Stage code never has to wrap toolbelt calls in try/catch.
 *  - A success appends a ledger entry, emits a `tool_call` StageEvent (Req 11.2),
 *    and returns the readable page text / search hits.
 *
 * Every call — success or failure — appends a {@link FetchLedgerEntry} BEFORE
 * returning, so the orchestrator's provenance check (see fetch-ledger.ts) has a
 * complete, append-only record of everything this run touched.
 *
 * HTML is reduced to readable text (scripts/styles/nav stripped) and truncated
 * to a token budget before it can reach an LLM prompt. A politeness delay and a
 * per-run request cap protect third-party sites from runaway crawls.
 *
 * All collaborators are injectable (search provider, ledger, emit callback, and
 * optionally the fetch transport + clock + sleep), so tests can stub the
 * transport while exercising the real toolbelt + real ledger.
 */

import { createHash } from "node:crypto";

import {
  UNKNOWN,
  type FetchLedgerEntry,
  type FetchedPage,
  type Maybe,
  type ResearchToolbelt,
  type SearchHit,
  type SearchProvider,
  type StageEvent,
  type StageNumber,
} from "@/agent/contracts";
import { getConfig } from "@/lib/config/env";
import type { FetchLedger, LedgerErrorKind } from "./fetch-ledger";

// ---------------------------------------------------------------------------
// Injectable collaborators
// ---------------------------------------------------------------------------

/** The subset of StageEvent the toolbelt fills in; the run harness adds the rest. */
export type ToolbeltEmit = (
  event: Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">,
) => void;

/** Stage attribution for ledger entries and emitted events. */
export interface ToolbeltStageInfo {
  stage: StageNumber;
  stageName: string;
}

/** Minimal, `global.fetch`-compatible transport so tests can stub the network. */
export type FetchImpl = typeof fetch;

export interface ResearchToolbeltDeps {
  /** The configured search adapter (see `providers/search`). */
  searchProvider: SearchProvider;
  /** The per-run, append-only fetch ledger (see `fetch-ledger.ts`). */
  ledger: FetchLedger;
  /** Emits `tool_call` / `tool_error` events; the harness supplies seq/id/etc. */
  emit: ToolbeltEmit;
  /**
   * Stage attribution. A function so a single shared toolbelt can reflect the
   * currently-running stage; a fixed value is also accepted. Defaults to
   * Stage 2 (Researcher), the primary toolbelt consumer.
   */
  stageInfo?: ToolbeltStageInfo | (() => ToolbeltStageInfo);
  /** Transport override for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Clock override for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Sleep override so tests skip the politeness delay. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout (ms). Defaults to `getConfig().requestTimeoutMs`. */
  requestTimeoutMs?: number;
  /** Max page fetches per run. Defaults to `getConfig().crawlMaxPages`. */
  maxPageFetchesPerRun?: number;
  /** Delay between page fetches (ms). Defaults to {@link DEFAULT_POLITENESS_DELAY_MS}. */
  politenessDelayMs?: number;
  /** Character budget for extracted text. Defaults to {@link DEFAULT_TEXT_CHAR_BUDGET}. */
  textCharBudget?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STAGE_INFO: ToolbeltStageInfo = { stage: 2, stageName: "Researcher" };
const DEFAULT_POLITENESS_DELAY_MS = 250;
const DEFAULT_SEARCH_MAX_RESULTS = 5;

/**
 * Extracted page text is truncated to a token budget before it can reach an LLM
 * prompt. Tokens are approximated at ~4 characters each, a deliberately
 * conservative ratio for English prose, giving a stable character ceiling.
 */
const DEFAULT_TOKEN_BUDGET = 6000;
const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_TEXT_CHAR_BUDGET = DEFAULT_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;

// ---------------------------------------------------------------------------
// HTML → readable text
// ---------------------------------------------------------------------------

/** Element blocks whose entire contents are non-content noise and get removed. */
const NOISE_BLOCK_TAGS =
  "script|style|noscript|head|nav|footer|header|aside|svg|template|form|iframe|button";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#34": '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : safeFromCodePoint(code, match);
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : safeFromCodePoint(code, match);
    }
    return match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Reduce raw HTML to readable text: strip script/style/nav/etc. blocks and
 * comments, turn block-closing tags into line breaks so structure survives,
 * strip the remaining tags, decode common entities, and collapse whitespace.
 * A lightweight readability pass — not a full DOM parse — which keeps the
 * toolbelt dependency-free and never throws on malformed markup.
 */
export function extractReadableText(html: string): string {
  let s = html;
  s = s.replace(new RegExp(`<(${NOISE_BLOCK_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), " ");
  // Drop any unclosed noise openers that survived the block removal.
  s = s.replace(new RegExp(`<(?:${NOISE_BLOCK_TAGS})\\b[^>]*>`, "gi"), " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|ul|ol|table)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v\r]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function looksLikeHtml(contentType: string | null, body: string): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("html") || ct.includes("xml")) return true;
    if (ct.includes("text/plain") || ct.includes("json")) return false;
  }
  return /<\/?[a-z][\s\S]*>/i.test(body);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Research Toolbelt bound to a run's ledger, search provider, and emit
 * callback. All other collaborators fall back to production defaults, so a
 * caller supplies only what it wants to control (tests inject a fake transport
 * + clock + sleep and drive the real toolbelt against the real ledger).
 */
export function createResearchToolbelt(deps: ResearchToolbeltDeps): ResearchToolbelt {
  const { searchProvider, ledger, emit } = deps;

  // Resolve config-backed knobs once. `getConfig()` is only consulted when a
  // knob is not explicitly injected, so tests that override everything never
  // require a populated environment.
  const requestTimeoutMs = deps.requestTimeoutMs ?? getConfig().requestTimeoutMs;
  const maxPageFetchesPerRun = deps.maxPageFetchesPerRun ?? getConfig().crawlMaxPages;
  const politenessDelayMs = deps.politenessDelayMs ?? DEFAULT_POLITENESS_DELAY_MS;
  const textCharBudget = deps.textCharBudget ?? DEFAULT_TEXT_CHAR_BUDGET;

  const doFetch: FetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const stageInfoOption = deps.stageInfo;
  function currentStage(): ToolbeltStageInfo {
    if (typeof stageInfoOption === "function") return stageInfoOption();
    return stageInfoOption ?? DEFAULT_STAGE_INFO;
  }

  // Per-run counter guarding against runaway crawls (the page-fetch cap).
  let pageFetchCount = 0;

  function emitToolCall(kind: "search" | "page_fetch", urlOrQuery: string, statusCode: Maybe<number>, retrievedAt: string, message: string): void {
    const { stage, stageName } = currentStage();
    emit({
      stage,
      stageName,
      type: "tool_call",
      message,
      toolCall: { kind, urlOrQuery, statusCode, retrievedAt },
    });
  }

  function emitToolError(kind: "search" | "page_fetch", urlOrQuery: string, statusCode: Maybe<number>, retrievedAt: string, message: string): void {
    const { stage, stageName } = currentStage();
    emit({
      stage,
      stageName,
      type: "tool_error",
      message,
      toolCall: { kind, urlOrQuery, statusCode, retrievedAt },
    });
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  async function search(query: string, opts?: { maxResults?: number }): Promise<SearchHit[]> {
    const maxResults = opts?.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
    const retrievedAt = now().toISOString();
    // Synthetic identifier for the ledger; the provenance check keys on page
    // URLs, so a search entry is an audit record, not a citation target.
    const requestedUrl = `tool:search/${searchProvider.name}`;

    try {
      const hits = await searchProvider.search(query, { maxResults });
      const list = Array.isArray(hits) ? hits : [];

      ledger.appendEntry({
        stage: currentStage().stage,
        kind: "search",
        requestedUrl,
        query,
        statusCode: 200,
        retrievedAt,
        contentBytes: UNKNOWN,
      });
      emitToolCall("search", query, 200, retrievedAt, `Search "${query}" → ${list.length} result(s)`);
      return list;
    } catch (error) {
      const errorKind = classifyError(error);
      ledger.appendEntry({
        stage: currentStage().stage,
        kind: "search",
        requestedUrl,
        query,
        statusCode: UNKNOWN,
        errorKind,
        retrievedAt,
      });
      emitToolError("search", query, UNKNOWN, retrievedAt, `Search "${query}" failed (${errorKind}); returning no results`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // fetchPage
  // -------------------------------------------------------------------------

  async function fetchPage(url: string): Promise<FetchedPage | null> {
    // Per-run request cap: refuse further fetches once the crawl budget is spent.
    if (pageFetchCount >= maxPageFetchesPerRun) {
      const retrievedAt = now().toISOString();
      emitToolError(
        "page_fetch",
        url,
        UNKNOWN,
        retrievedAt,
        `Per-run page fetch cap (${maxPageFetchesPerRun}) reached; skipping ${url}`,
      );
      return null;
    }

    // Politeness delay between successive page fetches (never before the first).
    if (pageFetchCount > 0 && politenessDelayMs > 0) {
      await sleep(politenessDelayMs);
    }
    pageFetchCount += 1;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      const response = await doFetch(url, { signal: controller.signal, redirect: "follow" });
      const finalUrl = typeof response.url === "string" && response.url.length > 0 ? response.url : url;
      const statusCode = response.status;
      const retrievedAt = now().toISOString();

      if (!response.ok) {
        // Non-2xx is a degradation path, not an exception (Req 17.1).
        ledger.appendEntry({
          stage: currentStage().stage,
          kind: "page_fetch",
          requestedUrl: url,
          finalUrl,
          statusCode,
          errorKind: "http_error",
          retrievedAt,
        });
        emitToolError("page_fetch", url, statusCode, retrievedAt, `Fetch ${url} returned status ${statusCode}; returning null`);
        return null;
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        ledger.appendEntry({
          stage: currentStage().stage,
          kind: "page_fetch",
          requestedUrl: url,
          finalUrl,
          statusCode,
          errorKind: "parse_error",
          retrievedAt,
        });
        emitToolError("page_fetch", url, statusCode, retrievedAt, `Fetch ${url} body read failed (${classifyError(error)}); returning null`);
        return null;
      }

      const contentType = safeContentType(response);
      const text = truncateToBudget(
        looksLikeHtml(contentType, raw) ? extractReadableText(raw) : raw.trim(),
        textCharBudget,
      );
      const contentHash = createHash("sha256").update(text).digest("hex");

      ledger.appendEntry({
        stage: currentStage().stage,
        kind: "page_fetch",
        requestedUrl: url,
        finalUrl,
        statusCode,
        retrievedAt,
        contentBytes: Buffer.byteLength(text, "utf8"),
        contentHash,
      });
      emitToolCall("page_fetch", url, statusCode, retrievedAt, `Fetched ${url} (${statusCode}, ${text.length} chars)`);

      return {
        requestedUrl: url,
        finalUrl,
        statusCode,
        text,
        retrievedAt,
        fromCache: false,
      };
    } catch (error) {
      const retrievedAt = now().toISOString();
      const errorKind: LedgerErrorKind = timedOut ? "timeout" : classifyError(error);
      ledger.appendEntry({
        stage: currentStage().stage,
        kind: "page_fetch",
        requestedUrl: url,
        statusCode: UNKNOWN,
        errorKind,
        retrievedAt,
      });
      const detail = errorKind === "timeout" ? `timed out after ${requestTimeoutMs}ms` : errorKind;
      emitToolError("page_fetch", url, UNKNOWN, retrievedAt, `Fetch ${url} failed (${detail}); returning null`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // ledger passthroughs
  // -------------------------------------------------------------------------

  function getLedger(): readonly FetchLedgerEntry[] {
    return ledger.getLedger();
  }

  function isLedgered(url: string): boolean {
    return ledger.isLedgered(url);
  }

  return { search, fetchPage, getLedger, isLedgered };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify a thrown transport error into a ledger error kind. */
function classifyError(error: unknown): LedgerErrorKind {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "timeout";
    if (error.name === "TimeoutError") return "timeout";
  }
  return "network";
}

function safeContentType(response: Response): string | null {
  try {
    return response.headers.get("content-type");
  } catch {
    return null;
  }
}

function truncateToBudget(text: string, charBudget: number): string {
  if (text.length <= charBudget) return text;
  return text.slice(0, charBudget);
}
