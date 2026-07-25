/**
 * Property 35 — The toolbelt degrades instead of throwing.
 *
 * **Validates: Requirements 17.1, 17.2**
 *
 * The Research Toolbelt is the sole web-egress point and is contractually a
 * *degrading* service, never a throwing one:
 *
 *   - Req 17.1: a non-success (non-2xx) response, or a network/parse failure,
 *     appends a ledger entry, emits a `tool_error` StageEvent carrying the
 *     request URL/query and the response status (or error kind), and returns an
 *     empty result (`null` for `fetchPage`, `[]` for `search`).
 *   - Req 17.2: a request that exceeds the timeout is aborted, produces a
 *     timeout `tool_error` StageEvent, and returns an empty result.
 *
 * This file drives the REAL toolbelt and the REAL fetch ledger, replacing only
 * the network hop: `fetchImpl` (a `typeof fetch` stub) is made to fail every
 * way fast-check can express — throw synchronously, reject with a network
 * error, reject with an abort, return a 4xx/5xx `Response`, or return a body
 * that fails to read — and the search provider is made to throw. For every such
 * failure we assert the call never throws, returns the degraded value, appends
 * a ledger entry, and emits a matching `tool_error` event.
 *
 * A simulated `sleep` skips the politeness delay and a deterministic `now`
 * keeps timestamps fixed, so the suite never touches real timers except the one
 * dedicated real-abort test that exercises the `AbortController` timeout path
 * with a tiny timeout budget.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createFetchLedger } from "@/research/fetch-ledger";
import {
  createResearchToolbelt,
  type FetchImpl,
  type ToolbeltEmit,
} from "@/research/toolbelt";
import { createStubSearchProvider } from "@tests/support/stub-llm";

import { arbEdgeString, arbUrl } from "./arbitraries";

/** The event shape the toolbelt hands to `emit` (harness fills in the rest). */
type EmittedEvent = Parameters<ToolbeltEmit>[0];

const FIXED_NOW = () => new Date("2024-01-01T00:00:00.000Z");
const NO_SLEEP = async () => {};

// ---------------------------------------------------------------------------
// Fake `fetch` transports (the only stubbed hop)
// ---------------------------------------------------------------------------

/** A minimal `Response` stand-in exposing only what the toolbelt reads. */
function fakeResponse(opts: {
  url: string;
  status: number;
  ok?: boolean;
  contentType?: string | null;
  text?: () => Promise<string>;
}): Response {
  return {
    url: opts.url,
    status: opts.status,
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    headers: { get: (_name: string) => opts.contentType ?? "text/html" },
    text: opts.text ?? (async () => "<html><body>ok</body></html>"),
  } as unknown as Response;
}

/** Every way a transport can fail, as data (converted to a stub by the test). */
type FetchFault =
  | { tag: "sync-throw" }
  | { tag: "reject-network" }
  | { tag: "reject-abort" }
  | { tag: "http"; status: number }
  | { tag: "malformed-body" };

const arbFetchFault: fc.Arbitrary<FetchFault> = fc.oneof(
  fc.constant<FetchFault>({ tag: "sync-throw" }),
  fc.constant<FetchFault>({ tag: "reject-network" }),
  fc.constant<FetchFault>({ tag: "reject-abort" }),
  fc
    .constantFrom(400, 401, 403, 404, 408, 429, 500, 502, 503, 504)
    .map<FetchFault>((status) => ({ tag: "http", status })),
  fc.constant<FetchFault>({ tag: "malformed-body" }),
);

/** Build a `typeof fetch` stub that fails in the requested way. */
function buildFetchImpl(fault: FetchFault, url: string): FetchImpl {
  const impl = (_input: unknown, _init?: unknown): Promise<Response> => {
    switch (fault.tag) {
      case "sync-throw":
        // A synchronous explosion inside the awaited transport call.
        throw new Error("sync transport explosion");
      case "reject-network": {
        const error = new Error("ENOTFOUND example.invalid");
        error.name = "TypeError";
        return Promise.reject(error);
      }
      case "reject-abort": {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      case "http":
        return Promise.resolve(fakeResponse({ url, status: fault.status }));
      case "malformed-body":
        return Promise.resolve(
          fakeResponse({
            url,
            status: 200,
            ok: true,
            text: () => Promise.reject(new Error("body read failed")),
          }),
        );
    }
  };
  return impl as unknown as FetchImpl;
}

// ---------------------------------------------------------------------------
// Property 35 — fetchPage degradation (Req 17.1, 17.2)
// ---------------------------------------------------------------------------

describe("Property 35: the toolbelt degrades instead of throwing", () => {
  it("fetchPage returns null, ledgers the request, and emits tool_error for any transport failure", async () => {
    await fc.assert(
      fc.asyncProperty(arbUrl, arbFetchFault, async (url, fault) => {
        const events: EmittedEvent[] = [];
        const ledger = createFetchLedger("run_prop35_fetch");
        const toolbelt = createResearchToolbelt({
          searchProvider: createStubSearchProvider(),
          ledger,
          emit: (event) => events.push(event),
          fetchImpl: buildFetchImpl(fault, url),
          now: FIXED_NOW,
          sleep: NO_SLEEP,
          requestTimeoutMs: 15_000,
          maxPageFetchesPerRun: 1_000,
          politenessDelayMs: 0,
        });

        // 1. Never throws; degrades to null.
        const result = await toolbelt.fetchPage(url);
        expect(result).toBeNull();

        // 2. A ledger entry was appended for this request (Req 17.1 audit).
        const ledgered = toolbelt
          .getLedger()
          .filter((e) => e.kind === "page_fetch" && e.requestedUrl === url);
        expect(ledgered.length).toBeGreaterThanOrEqual(1);
        // A failed fetch is never recorded as a success.
        expect(ledgered.every((e) => e.ok === false)).toBe(true);

        // 3. A tool_error event carrying the request URL was emitted.
        const errorEvents = events.filter(
          (e) => e.type === "tool_error" && e.toolCall?.urlOrQuery === url,
        );
        expect(errorEvents.length).toBeGreaterThanOrEqual(1);

        // 3a. A non-success response carries its status code (Req 17.1);
        //     transport/abort/parse failures carry an "unknown" status.
        if (fault.tag === "http") {
          expect(
            errorEvents.some((e) => e.toolCall?.statusCode === fault.status),
          ).toBe(true);
          expect(
            ledgered.some((e) => e.statusCode === fault.status),
          ).toBe(true);
        }
        if (fault.tag === "reject-abort") {
          // The abort is classified as a timeout in the ledger (Req 17.2).
          expect(ledgered.some((e) => e.errorKind === "timeout")).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 35 — search degradation (Req 17.1)
  // -------------------------------------------------------------------------

  it("search returns [] , ledgers the request, and emits tool_error when the provider throws", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEdgeString,
        fc.boolean(),
        async (query, rejectAsync) => {
          const events: EmittedEvent[] = [];
          const ledger = createFetchLedger("run_prop35_search");
          // A search provider that always fails — synchronously or via rejection.
          const searchProvider = createStubSearchProvider({
            respondWith: () => {
              const error = new Error("search backend unreachable");
              if (rejectAsync) return Promise.reject(error);
              throw error;
            },
          });
          const toolbelt = createResearchToolbelt({
            searchProvider,
            ledger,
            emit: (event) => events.push(event),
            // fetchImpl must never be reached on the search path.
            fetchImpl: (() =>
              Promise.reject(
                new Error("fetchImpl must not be called during search"),
              )) as unknown as FetchImpl,
            now: FIXED_NOW,
            sleep: NO_SLEEP,
            requestTimeoutMs: 15_000,
            maxPageFetchesPerRun: 1_000,
            politenessDelayMs: 0,
          });

          // 1. Never throws; degrades to [].
          const result = await toolbelt.search(query);
          expect(result).toEqual([]);

          // 2. A search ledger entry was appended.
          const ledgered = toolbelt
            .getLedger()
            .filter((e) => e.kind === "search" && e.query === query);
          expect(ledgered.length).toBeGreaterThanOrEqual(1);
          expect(ledgered.every((e) => e.ok === false)).toBe(true);

          // 3. A tool_error event carrying the query was emitted.
          const errorEvents = events.filter(
            (e) =>
              e.type === "tool_error" &&
              e.toolCall?.kind === "search" &&
              e.toolCall?.urlOrQuery === query,
          );
          expect(errorEvents.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Req 17.2 — the real AbortController timeout path
  // -------------------------------------------------------------------------

  it("fetchPage aborts on timeout, returns null, and ledgers a timeout (Req 17.2)", async () => {
    const events: EmittedEvent[] = [];
    const ledger = createFetchLedger("run_prop35_timeout");
    const url = "https://slow.example.com/never-responds";

    // A transport that only settles when the toolbelt's AbortController fires.
    const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      })) as unknown as FetchImpl;

    const toolbelt = createResearchToolbelt({
      searchProvider: createStubSearchProvider(),
      ledger,
      emit: (event) => events.push(event),
      fetchImpl,
      now: FIXED_NOW,
      sleep: NO_SLEEP,
      requestTimeoutMs: 15, // tiny budget so the abort fires promptly
      maxPageFetchesPerRun: 1_000,
      politenessDelayMs: 0,
    });

    const result = await toolbelt.fetchPage(url);
    expect(result).toBeNull();

    const timeoutEntry = toolbelt
      .getLedger()
      .find((e) => e.kind === "page_fetch" && e.requestedUrl === url);
    expect(timeoutEntry?.errorKind).toBe("timeout");
    expect(timeoutEntry?.ok).toBe(false);

    const errorEvent = events.find(
      (e) => e.type === "tool_error" && e.toolCall?.urlOrQuery === url,
    );
    expect(errorEvent).toBeDefined();
  });
});
