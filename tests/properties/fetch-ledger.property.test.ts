/**
 * Property 12 — The fetch ledger records every request the toolbelt made.
 *
 * **Validates: Requirements 5.4, 7.8**
 *
 * Req 5.4 says the run artifact must include the complete list of source URLs
 * requested during the run together with each response status. Req 7.8 says the
 * matcher must record the retrieved URL and response status of every page
 * request. Both reduce to one mechanical guarantee about the ledger the
 * toolbelt writes into: for ANY sequence of `search` / `fetchPage` calls, every
 * request the toolbelt made appears in `getLedger()` with its URL and status,
 * and nothing else appears.
 *
 * The test exercises the REAL toolbelt and the REAL fetch ledger, stubbing only
 * the two egress boundaries the design permits stubbing — the search provider
 * (`createStubSearchProvider`) and the raw page-fetch transport (a fake
 * `fetch`). This is the design's boundary exactly: "the Research Toolbelt is
 * used real in provenance tests, with only its transport stubbed", so the
 * production ledger-append path is what is under test.
 *
 * The toolbelt's `fetchPage` injection surface is a `fetch`-shaped transport
 * (`fetchImpl`), so the stub here returns `Response`-like objects and lets the
 * real toolbelt do its own status handling, HTML reduction, and ledger writing.
 * That is a stricter test than substituting a higher-level page stub, because
 * the toolbelt's own request→entry logic runs unchanged.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN, type FetchLedgerEntry, type Maybe } from "@/agent/contracts";
import { createFetchLedger, normalizeUrl } from "@/research/fetch-ledger";
import { createResearchToolbelt } from "@/research/toolbelt";
import { createStubSearchProvider } from "../support/stub-llm";
import { arbUrl } from "./arbitraries";

// ---------------------------------------------------------------------------
// Operation model
// ---------------------------------------------------------------------------

/** A scripted response the fake transport hands back for one `fetchPage` call. */
type ScriptedResponse =
  | { kind: "error" } // network/transport failure — fetch throws
  | { kind: "http"; status: number; finalUrl?: string; body?: string };

/** One toolbelt operation the property drives, in submission order. */
type Op =
  | { type: "search"; query: string }
  | { type: "fetch"; url: string; response: ScriptedResponse };

const SEARCH_PROVIDER_NAME = "tavily" as const;

// Statuses spanning the 2xx success path and the non-2xx degradation path.
const arbHttpStatus = fc.constantFrom(200, 201, 204, 301, 400, 403, 404, 500, 503);

const arbScriptedResponse: fc.Arbitrary<ScriptedResponse> = fc.oneof(
  fc.record({
    kind: fc.constant<"http">("http"),
    status: arbHttpStatus,
    // A distinct final URL models a redirect; absent means no redirect.
    finalUrl: fc.option(arbUrl, { nil: undefined }),
    body: fc.constant("<p>hello world</p>"),
  }),
  fc.constant<ScriptedResponse>({ kind: "error" }),
);

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ type: fc.constant<"search">("search"), query: fc.string() }),
  fc.record({
    type: fc.constant<"fetch">("fetch"),
    url: arbUrl,
    response: arbScriptedResponse,
  }),
);

/** A sequence of interleaved search/fetch operations. */
const arbOps: fc.Arbitrary<Op[]> = fc.array(arbOp, { maxLength: 20 });

// ---------------------------------------------------------------------------
// Expected ledger entries — derived independently from the toolbelt's rules
// ---------------------------------------------------------------------------

interface ExpectedEntry {
  kind: "search" | "page_fetch";
  requestedUrl: string;
  normalizedUrl: string;
  statusCode: Maybe<number>;
  ok: boolean;
  errorKind: Maybe<string>;
  query: Maybe<string>;
}

/** The final URL the toolbelt records: response.url when non-empty, else the requested URL. */
function resolveFinalUrl(url: string, finalUrl: string | undefined): string {
  return typeof finalUrl === "string" && finalUrl.length > 0 && finalUrl !== "unknown" ? finalUrl : url;
}

function expectedEntriesFor(op: Op): ExpectedEntry[] {
  if (op.type === "search") {
    return [
      {
        kind: "search",
        requestedUrl: `tool:search/${SEARCH_PROVIDER_NAME}`,
        normalizedUrl: normalizeUrl(`tool:search/${SEARCH_PROVIDER_NAME}`),
        statusCode: 200,
        ok: true,
        errorKind: UNKNOWN,
        query: op.query,
      },
    ];
  }

  const { url, response } = op;

  if (response.kind === "error") {
    // The transport threw: one entry, no status, classified as a network error.
    return [
      {
        kind: "page_fetch",
        requestedUrl: url,
        normalizedUrl: normalizeUrl(url),
        statusCode: UNKNOWN,
        ok: false,
        errorKind: "network",
        query: UNKNOWN,
      },
    ];
  }

  const ok = response.status >= 200 && response.status < 300;
  const errorKind: Maybe<string> = ok ? UNKNOWN : "http_error";
  const requestedEntry: ExpectedEntry = {
    kind: "page_fetch",
    requestedUrl: url,
    normalizedUrl: normalizeUrl(url),
    statusCode: response.status,
    ok,
    errorKind,
    query: UNKNOWN,
  };

  // A redirect whose final URL normalizes differently produces a second entry
  // (still keyed on the original requestedUrl, but with the final normalizedUrl).
  // The ledger deliberately skips a final-URL entry when that URL is empty or is
  // the literal `"unknown"` marker, so a bare marker cannot masquerade as a real
  // redirect target — the expectation mirrors that guard.
  const finalUrlUsed = resolveFinalUrl(url, response.finalUrl);
  const producesRedirectEntry =
    finalUrlUsed !== UNKNOWN &&
    finalUrlUsed.length > 0 &&
    normalizeUrl(finalUrlUsed) !== normalizeUrl(url);
  if (producesRedirectEntry) {
    return [
      requestedEntry,
      {
        kind: "page_fetch",
        requestedUrl: url,
        normalizedUrl: normalizeUrl(finalUrlUsed),
        statusCode: response.status,
        ok,
        errorKind,
        query: UNKNOWN,
      },
    ];
  }

  return [requestedEntry];
}

// ---------------------------------------------------------------------------
// Fake transport (the ONLY network hop the real toolbelt performs)
// ---------------------------------------------------------------------------

/**
 * Builds a `fetch`-shaped transport driven by a FIFO of scripted responses.
 * `fetchPage` performs exactly one transport call per invocation (when under
 * the crawl cap), so a queue consumed in call order is unambiguous.
 */
function makeFakeFetch(responses: ScriptedResponse[]): typeof fetch {
  let i = 0;
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const scripted = responses[i++];
    if (!scripted || scripted.kind === "error") {
      throw new TypeError(`simulated network failure for ${url}`);
    }
    const responseLike = {
      // Empty when no redirect: the toolbelt falls back to the requested URL.
      url: scripted.finalUrl ?? "",
      status: scripted.status,
      ok: scripted.status >= 200 && scripted.status < 300,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
      text: async () => scripted.body ?? "",
    };
    return responseLike as unknown as Response;
  };
  return impl as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function runOps(ops: Op[]): Promise<readonly FetchLedgerEntry[]> {
  const ledger = createFetchLedger("run_prop12");
  const searchProvider = createStubSearchProvider({ name: SEARCH_PROVIDER_NAME });

  // Only the fetch ops consume the transport, in their submission order.
  const fetchResponses = ops
    .filter((op): op is Extract<Op, { type: "fetch" }> => op.type === "fetch")
    .map((op) => op.response);

  const fetchCount = fetchResponses.length;

  const toolbelt = createResearchToolbelt({
    searchProvider,
    ledger,
    emit: () => {}, // events are asserted elsewhere; the ledger is the subject here
    fetchImpl: makeFakeFetch(fetchResponses),
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    sleep: async () => {}, // skip the politeness delay
    requestTimeoutMs: 1000,
    // Cap high enough that no request is skipped, so every op is recorded.
    maxPageFetchesPerRun: fetchCount + 1,
    politenessDelayMs: 0,
    textCharBudget: 100_000,
  });

  for (const op of ops) {
    if (op.type === "search") {
      await toolbelt.search(op.query);
    } else {
      await toolbelt.fetchPage(op.url);
    }
  }

  return ledger.getLedger();
}

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

describe("Property 12: the fetch ledger records every request the toolbelt made", () => {
  it("every search/fetch request appears in getLedger() with its URL and status", async () => {
    await fc.assert(
      fc.asyncProperty(arbOps, async (ops) => {
        const ledger = await runOps(ops);
        const expected = ops.flatMap(expectedEntriesFor);

        // 1. Count matches exactly — no request is dropped and none is invented,
        //    accounting for redirect double-entries (Req 5.4, 7.8).
        expect(ledger.length).toBe(expected.length);

        // 2. Each entry, in submission order, carries the right URL and status.
        for (let k = 0; k < expected.length; k++) {
          const actual = ledger[k]!;
          const want = expected[k]!;
          expect(actual.kind).toBe(want.kind);
          expect(actual.requestedUrl).toBe(want.requestedUrl);
          expect(actual.normalizedUrl).toBe(want.normalizedUrl);
          expect(actual.statusCode).toBe(want.statusCode);
          expect(actual.ok).toBe(want.ok);
          expect(actual.errorKind).toBe(want.errorKind);
          expect(actual.query).toBe(want.query);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("every fetchPage(url) — success or failure — yields an entry whose normalizedUrl matches", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ url: arbUrl, response: arbScriptedResponse }),
          { minLength: 1, maxLength: 15 },
        ),
        async (fetches) => {
          const ops: Op[] = fetches.map((f) => ({
            type: "fetch",
            url: f.url,
            response: f.response,
          }));
          const ledger = await runOps(ops);

          // Every requested URL has at least one ledger entry normalized to it.
          for (const f of fetches) {
            const target = normalizeUrl(f.url);
            const match = ledger.find(
              (e) =>
                e.kind === "page_fetch" &&
                e.requestedUrl === f.url &&
                e.normalizedUrl === target,
            );
            expect(match, `no ledger entry for fetchPage(${JSON.stringify(f.url)})`).toBeDefined();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // A concrete, human-readable anchor for the property above.
  it("records a search, a success fetch, and a redirecting fetch with correct statuses", async () => {
    const ops: Op[] = [
      { type: "search", query: "SQM lithium capex" },
      { type: "fetch", url: "https://example.com/a", response: { kind: "http", status: 200 } },
      {
        type: "fetch",
        url: "https://example.com/b",
        response: { kind: "http", status: 200, finalUrl: "https://example.com/b-final" },
      },
      { type: "fetch", url: "https://example.com/c", response: { kind: "error" } },
      { type: "fetch", url: "https://example.com/d", response: { kind: "http", status: 404 } },
    ];

    const ledger = await runOps(ops);

    // search(1) + a(1) + b(2, redirect) + c(1, error) + d(1) = 6 entries.
    expect(ledger.length).toBe(6);

    const search = ledger[0]!;
    expect(search.kind).toBe("search");
    expect(search.query).toBe("SQM lithium capex");
    expect(search.statusCode).toBe(200);
    expect(search.ok).toBe(true);

    const a = ledger[1]!;
    expect(a.requestedUrl).toBe("https://example.com/a");
    expect(a.statusCode).toBe(200);
    expect(a.ok).toBe(true);

    // Redirect produced two entries: requested and final, both status 200.
    const bReq = ledger[2]!;
    const bFinal = ledger[3]!;
    expect(bReq.normalizedUrl).toBe(normalizeUrl("https://example.com/b"));
    expect(bFinal.normalizedUrl).toBe(normalizeUrl("https://example.com/b-final"));
    expect(bFinal.ok).toBe(true);

    const c = ledger[4]!;
    expect(c.requestedUrl).toBe("https://example.com/c");
    expect(c.statusCode).toBe(UNKNOWN);
    expect(c.ok).toBe(false);
    expect(c.errorKind).toBe("network");

    const d = ledger[5]!;
    expect(d.statusCode).toBe(404);
    expect(d.ok).toBe(false);
    expect(d.errorKind).toBe("http_error");
  });
});
