/**
 * Stage 2 (Researcher) test harness (Tasks 8.3–8.6).
 *
 * Stage 2 is exercised end-to-end through its public `run(ctx)` entry point over
 * a REAL Research Toolbelt and a REAL fetch ledger, with only the two network
 * hops replaced:
 *
 *   - the search provider is a `createStubSearchProvider` returning scripted hits, and
 *   - the page-fetch transport is a `typeof fetch` stub returning canned `Response`
 *     objects (the toolbelt's real HTML→text + ledger path runs around it).
 *
 * The LLM is a `createStubLlmProvider`, so no test touches the network or a live
 * model (design: Mocking Boundaries). All config-backed toolbelt knobs are
 * supplied explicitly so `getConfig()` is never consulted and the suite needs no
 * populated environment.
 */

import {
  UNKNOWN,
  type LeadProfile,
  type QualificationResult,
  type ResearchToolbelt,
  type StageContext,
  type StageEvent,
  type Unknown,
} from "@/agent/contracts";
import { createFetchLedger, type FetchLedger } from "@/research/fetch-ledger";
import { createResearchToolbelt, type FetchImpl } from "@/research/toolbelt";
import {
  createStubLlmProvider,
  createStubSearchProvider,
  type StubLlmProvider,
  type StubLlmResponder,
  type StubSearchProvider,
  type StubSearchResponder,
} from "@tests/support/stub-llm";

/** The event shape stage code and the toolbelt hand to `emit`. */
export type RecordedEvent = Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">;

const FIXED_NOW = () => new Date("2024-01-01T00:00:00.000Z");
const NO_SLEEP = async () => {};

/** A minimal, deterministic `LeadProfile` for tests that don't generate one. */
export function makeLeadProfile(overrides: Partial<LeadProfile> = {}): LeadProfile {
  return {
    leadId: "lead_test_1",
    senderName: "Dana Reyes",
    senderEmail: "dana@acme.example.com",
    title: "VP of Operations",
    division: "Mining Operations",
    company: "Acme Resources",
    companyDomain: "acme.example.com",
    country: "Australia",
    region: "APAC",
    industry: "Mining",
    statedUseCase: "autonomous site inspection",
    statedPainPoints: ["manual inspections are slow"],
    referralSource: UNKNOWN,
    statedTimeline: UNKNOWN,
    siteCount: 12,
    rawEmail: {
      fromName: "Dana Reyes",
      fromEmail: "dana@acme.example.com",
      subject: "Drone inspection inquiry",
      body: "We want to automate inspections across our sites.",
      receivedAt: "2024-01-01T00:00:00.000Z",
    },
    normalizedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A canned page the fetch-transport stub can serve for a URL. */
export interface StubPage {
  text: string;
  status?: number;
  contentType?: string;
  finalUrl?: string;
}

/** A minimal `Response` stand-in exposing only what the toolbelt reads. */
function fakeResponse(url: string, page: StubPage): Response {
  const status = page.status ?? 200;
  return {
    url: page.finalUrl ?? url,
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (_name: string) => page.contentType ?? "text/plain" },
    text: async () => page.text,
  } as unknown as Response;
}

/**
 * Build a `typeof fetch` stub from a URL→page map. A URL that is not mapped
 * rejects with a network error, which the real toolbelt degrades to `null`
 * (modelling a fetch that produced no usable page).
 */
function buildFetchImpl(pages: Record<string, StubPage>): FetchImpl {
  const impl = (input: unknown): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const page = pages[url];
    if (!page) {
      return Promise.reject(new Error(`no stub page for ${url}`));
    }
    return Promise.resolve(fakeResponse(url, page));
  };
  return impl as unknown as FetchImpl;
}

export interface Stage2HarnessOptions {
  /** The lead the stage researches. Defaults to {@link makeLeadProfile}. */
  lead?: LeadProfile;
  /** Upstream qualification. Defaults to `"unknown"` (Stage 2 does not read it). */
  qualification?: QualificationResult | Unknown;
  /** Scripted search hits. Defaults to `[]` (every dimension unsupported). */
  search?: StubSearchResponder;
  /** URL→page map served by the fetch transport. Unmapped URLs resolve to null. */
  pages?: Record<string, StubPage>;
  /** Full fetch-transport override (takes precedence over `pages`). */
  fetchImpl?: FetchImpl;
  /** Scripted LLM responder. Defaults to a schema-valid generated value. */
  llm?: StubLlmResponder;
  /** Observe every `completeJson` arg set (e.g. to branch on `purpose`). */
  onLlmCall?: Parameters<typeof createStubLlmProvider>[0]["onCall"];
}

export interface Stage2Harness {
  ctx: StageContext;
  events: RecordedEvent[];
  ledger: FetchLedger;
  toolbelt: ResearchToolbelt;
  llm: StubLlmProvider;
  searchProvider: StubSearchProvider;
}

/**
 * Assemble a {@link StageContext} plus its real toolbelt / real ledger for
 * driving `stage2Researcher.run`. The returned `events` array records every
 * event emitted by both the stage and the toolbelt, in order.
 */
export function createStage2Harness(options: Stage2HarnessOptions = {}): Stage2Harness {
  const lead = options.lead ?? makeLeadProfile();
  const runId = "run_stage2_test";

  const events: RecordedEvent[] = [];
  const emit = (event: RecordedEvent) => {
    events.push(event);
  };

  const ledger = createFetchLedger(runId);
  const searchProvider = createStubSearchProvider({ respondWith: options.search });

  const fetchImpl =
    options.fetchImpl ?? buildFetchImpl(options.pages ?? {});

  const toolbelt = createResearchToolbelt({
    searchProvider,
    ledger,
    emit,
    fetchImpl,
    now: FIXED_NOW,
    sleep: NO_SLEEP,
    // Explicit knobs so getConfig() is never consulted.
    requestTimeoutMs: 15_000,
    maxPageFetchesPerRun: 1_000,
    politenessDelayMs: 0,
  });

  const llm = createStubLlmProvider({
    respondWith: options.llm,
    onCall: options.onLlmCall,
  });

  const ctx: StageContext = {
    runId,
    leadProfile: lead,
    toolbelt,
    llm,
    emit,
    attempt: 1,
    upstream: { qualification: options.qualification ?? UNKNOWN },
  };

  return { ctx, events, ledger, toolbelt, llm, searchProvider };
}
