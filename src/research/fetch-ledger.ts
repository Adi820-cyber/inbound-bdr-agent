/**
 * Per-run fetch ledger (Req 5.3, 5.4).
 *
 * This is the anti-fabrication control. The ledger is a per-run, append-only
 * record of every request the Research Toolbelt made. The orchestrator later
 * cross-checks every claim's `sourceUrl` against it: a claim is only accepted
 * when its URL was actually requested during this run AND returned a success
 * (2xx) status. An LLM cannot smuggle a plausible-looking URL past this check,
 * because the check never consults the LLM.
 *
 * Two invariants make it hold:
 *  - URLs are **normalized before comparison** (lowercase scheme/host, strip
 *    default port, trailing slash, fragment, and tracking query params) so a
 *    trivially-reformatted URL cannot bypass the check and a legitimately
 *    identical URL is not falsely rejected.
 *  - Redirects are recorded as **separate entries** for both the requested and
 *    the final URL, so a claim citing either resolves.
 *
 * `isLedgered(url)` returns true ONLY when the normalized URL has a ledgered
 * entry with a success (2xx) status — being requested is not enough, because
 * Req 4.7 requires a success response.
 */

import type { FetchLedgerEntry, Maybe, StageNumber } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";

export type LedgerErrorKind = "timeout" | "network" | "http_error" | "parse_error";

/**
 * Everything the toolbelt knows at the moment it appends an entry. Derived
 * fields (`normalizedUrl`, `ok`, `entryId`) are computed by the ledger, never
 * supplied by the caller, so stage code cannot forge a "successful" entry.
 */
export interface AppendEntryInput {
  stage: StageNumber;
  kind: "search" | "page_fetch";
  requestedUrl: string;
  finalUrl?: Maybe<string>;
  query?: Maybe<string>;
  statusCode?: Maybe<number>;
  errorKind?: Maybe<LedgerErrorKind>;
  retrievedAt: string;
  contentBytes?: Maybe<number>;
  contentHash?: Maybe<string>;
}

export interface FetchLedger {
  /**
   * Appends the request to the ledger. When the final URL differs (a redirect)
   * from the requested URL after normalization, a second entry keyed on the
   * final URL is appended so a claim citing either URL resolves. Returns the
   * entries that were created.
   */
  appendEntry(input: AppendEntryInput): FetchLedgerEntry[];
  /** True only when `url` normalizes to a ledgered entry with a 2xx status. */
  isLedgered(url: string): boolean;
  /** The complete, append-only ledger, including failed requests (Req 5.4). */
  getLedger(): readonly FetchLedgerEntry[];
}

/**
 * Tracking / analytics query parameters that carry no addressing meaning and
 * must be dropped before comparison. Any parameter whose (lowercased) name
 * begins with `utm_` is also treated as tracking.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "source",
  "spm",
  "vero_id",
  "oly_anon_id",
  "oly_enc_id",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_PARAMS.has(k);
}

/**
 * Normalize a URL for ledger comparison. Never throws — an unparseable URL
 * falls back to a lowercased, fragment- and trailing-slash-stripped form so
 * adversarial URL shapes degrade instead of crashing the run.
 */
export function normalizeUrl(raw: string): string {
  const input = (raw ?? "").trim();

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    const withoutFragment = input.split("#", 1)[0] ?? "";
    return withoutFragment.replace(/\/+$/, "").toLowerCase();
  }

  const protocol = u.protocol.toLowerCase(); // includes trailing ":"
  const host = u.hostname.toLowerCase();

  // Strip default ports.
  let port = u.port;
  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    port = "";
  }
  const authority = port ? `${host}:${port}` : host;

  // Strip trailing slash(es) from the path. Root "/" collapses to "".
  const pathname = u.pathname.replace(/\/+$/, "");

  // Drop tracking params; preserve remaining params in their original order.
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(u.search)) {
    if (!isTrackingParam(key)) kept.append(key, value);
  }
  const keptString = kept.toString();
  const search = keptString ? `?${keptString}` : "";

  // Fragment (u.hash) is intentionally dropped.
  if (authority) {
    return `${protocol}//${authority}${pathname}${search}`;
  }
  // Non-authority schemes (e.g. mailto:) — deterministic best effort.
  return `${protocol}${pathname}${search}`;
}

/** A 2xx response is the only "success" the provenance check accepts (Req 4.7). */
function isSuccessStatus(statusCode: Maybe<number>): boolean {
  return typeof statusCode === "number" && statusCode >= 200 && statusCode < 300;
}

function computeOk(input: AppendEntryInput): boolean {
  if (input.errorKind && input.errorKind !== UNKNOWN) return false;
  return isSuccessStatus(input.statusCode ?? UNKNOWN);
}

/**
 * Create a fresh, per-run fetch ledger. The internal entry array is private and
 * append-only: callers receive only frozen copies via `getLedger`, and only the
 * toolbelt's own call path invokes `appendEntry`.
 */
export function createFetchLedger(runId: string): FetchLedger {
  const entries: FetchLedgerEntry[] = [];
  let counter = 0;

  function nextEntryId(): string {
    counter += 1;
    return `led_${runId}_${counter}`;
  }

  function buildEntry(input: AppendEntryInput, normalizedUrl: string): FetchLedgerEntry {
    return {
      entryId: nextEntryId(),
      runId,
      stage: input.stage,
      kind: input.kind,
      requestedUrl: input.requestedUrl,
      finalUrl: input.finalUrl ?? UNKNOWN,
      normalizedUrl,
      query: input.query ?? UNKNOWN,
      statusCode: input.statusCode ?? UNKNOWN,
      ok: computeOk(input),
      errorKind: input.errorKind ?? UNKNOWN,
      retrievedAt: input.retrievedAt,
      contentBytes: input.contentBytes ?? UNKNOWN,
      contentHash: input.contentHash ?? UNKNOWN,
    };
  }

  function appendEntry(input: AppendEntryInput): FetchLedgerEntry[] {
    const created: FetchLedgerEntry[] = [];

    const requestedNormalized = normalizeUrl(input.requestedUrl);
    const requestedEntry = buildEntry(input, requestedNormalized);
    entries.push(requestedEntry);
    created.push(requestedEntry);

    // Record a redirect target as its own entry so a claim citing the final
    // URL also resolves (Req 5.4).
    const finalUrl = input.finalUrl;
    if (typeof finalUrl === "string" && finalUrl !== UNKNOWN && finalUrl.length > 0) {
      const finalNormalized = normalizeUrl(finalUrl);
      if (finalNormalized !== requestedNormalized) {
        const finalEntry = buildEntry(input, finalNormalized);
        entries.push(finalEntry);
        created.push(finalEntry);
      }
    }

    return created;
  }

  function isLedgered(url: string): boolean {
    const normalized = normalizeUrl(url);
    return entries.some((entry) => entry.normalizedUrl === normalized && entry.ok);
  }

  function getLedger(): readonly FetchLedgerEntry[] {
    return Object.freeze(entries.slice());
  }

  return { appendEntry, isLedgered, getLedger };
}
