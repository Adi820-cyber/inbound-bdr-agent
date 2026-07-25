/**
 * Property 37: Total retrieval failure produces only unknowns, never placeholders
 *
 * **Validates: Requirements 17.3, 17.5, 17.6**
 *
 * This test drives the REAL full pipeline — `runPipeline` with the REAL
 * `DEFAULT_STAGES` (all six concrete stage modules, in order) — under total
 * retrieval failure: every toolbelt `search` returns `[]` and every `fetchPage`
 * returns `null`, so not one byte of web evidence is available and the run's
 * fetch ledger stays empty.
 *
 * Only the boundaries are stubbed, exactly as the design's Mocking Boundaries
 * rule requires: the LLM (via `createStubLlmProvider`), the toolbelt transport,
 * `validateEnv`, `providerConfig`, and the run store (so nothing is written to
 * disk). No network, no live model, no `process.env` read.
 *
 * The degradation contract asserted here:
 *
 *  1. The run COMPLETES — it never throws, however total the retrieval failure
 *     (Req 17.1–17.3). Stages that cannot honour their contract without evidence
 *     degrade; the loop keeps going.
 *  2. The run status is `complete` or `partial`, never `failed` and never a
 *     crash (Req 17.3).
 *  3. Every research claim that exists holds exactly `"unknown"` for its text,
 *     source URL, and `retrievedAt`, with `verificationStatus: "unknown"` — no
 *     claim can be verified when the ledger is empty (Req 17.3, 5.1–5.3).
 *  4. `verifiedClaimCount` is 0.
 *  5. NO placeholder, sample, or illustrative factual value appears anywhere in
 *     the six stage outputs: the ONLY substituted value is the literal
 *     `"unknown"` (Req 17.6). The serialized outputs are scanned for the
 *     canonical placeholder tells (`TBD`, `N/A`, `example.com`, `Lorem ipsum`,
 *     `placeholder`, `dummy`, `foo`/`bar`, …).
 *  6. The `unknownFieldReport` is NON-EMPTY, so the gaps are reported honestly
 *     rather than silently (Req 5.7, 17.5), and each reported substitution has a
 *     matching `unknown_substitution` event.
 *
 * Stage modules that cannot produce a schema-valid output from the stub model's
 * minimal values degrade to `failed`/`"unknown"` — which is itself a valid
 * Property-37 outcome, and precisely the contract being asserted. The test
 * therefore checks the DEGRADATION CONTRACT rather than pinning a particular
 * stage's success.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  FetchLedgerEntry,
  RawEmailRecord,
  ResearchReport,
  ResearchToolbelt,
  RunArtifact,
  RunSummary,
  StageEvent,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";
import type { RunStore } from "@/store/run-store";

import { stubProviderConfig } from "@tests/support/orchestrator-harness";
import { createStubLlmProvider } from "@tests/support/stub-llm";

import { arbRawEmail } from "./arbitraries";

// ---------------------------------------------------------------------------
// Total-failure boundaries
// ---------------------------------------------------------------------------

interface TotalFailureToolbelt extends ResearchToolbelt {
  /** Every query the pipeline attempted, in order. */
  readonly searchCalls: readonly string[];
  /** Every URL the pipeline attempted to fetch, in order. */
  readonly fetchCalls: readonly string[];
}

/**
 * A toolbelt in which ALL retrieval fails. It degrades exactly like the real
 * toolbelt does on a non-success response or timeout (Req 17.1, 17.2): empty
 * result, `null` page, and nothing appended to the ledger — so no URL can ever
 * satisfy the provenance gate.
 */
function createTotalFailureToolbelt(): TotalFailureToolbelt {
  const searchCalls: string[] = [];
  const fetchCalls: string[] = [];
  return {
    searchCalls,
    fetchCalls,
    async search(query) {
      searchCalls.push(query);
      return [];
    },
    async fetchPage(url) {
      fetchCalls.push(url);
      return null;
    },
    getLedger(): readonly FetchLedgerEntry[] {
      return [];
    },
    isLedgered() {
      return false;
    },
  };
}

/** An in-memory run store, so a run under test never writes to `.data/runs/`. */
function createMemoryRunStore(): RunStore & { readonly puts: RunArtifact[] } {
  const puts: RunArtifact[] = [];
  return {
    puts,
    isDurable: false,
    async put(artifact) {
      puts.push(artifact);
    },
    async get() {
      return null;
    },
    async list(): Promise<RunSummary[]> {
      return [];
    },
  };
}

interface TotalFailureRun {
  artifact: RunArtifact;
  events: StageEvent[];
  toolbelt: TotalFailureToolbelt;
}

/**
 * Runs the REAL six-stage pipeline (no `deps.stages` override) with every
 * retrieval path failing.
 */
async function runWithTotalRetrievalFailure(
  rawEmail?: RawEmailRecord,
): Promise<TotalFailureRun> {
  const events: StageEvent[] = [];
  const toolbelt = createTotalFailureToolbelt();

  const artifact = await runPipeline({
    ...(rawEmail === undefined ? {} : { rawEmail }),
    onEvent: (event) => events.push(event),
    deps: {
      // NOTE: `stages` is deliberately NOT injected — DEFAULT_STAGES runs.
      llm: createStubLlmProvider(),
      toolbelt,
      providerConfig: stubProviderConfig(),
      validateEnv: () => {},
      runStore: createMemoryRunStore(),
    },
  });

  return { artifact, events, toolbelt };
}

// ---------------------------------------------------------------------------
// Placeholder detection (Req 17.6)
// ---------------------------------------------------------------------------

/**
 * The canonical tells of a placeholder, sample, or illustrative value. Req 17.6
 * permits exactly ONE substitute for an unretrievable fact — the literal
 * `"unknown"` — so any of these appearing in a stage output is a violation.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bTBD\b/i,
  /\bN\s*\/\s*A\b/i,
  /example\.(?:com|org|net)/i,
  /\blorem\b/i,
  /\bipsum\b/i,
  /\bplaceholder\b/i,
  /\bdummy\b/i,
  /\bfoo\b/i,
  /\bbar\b/i,
  /\bsample (?:value|data|company|customer)\b/i,
  /\bcoming soon\b/i,
  /\bfill me in\b/i,
  /\bacme\b/i,
  /\bXXXX+\b/,
  /\bto be (?:determined|confirmed|provided)\b/i,
];

/** Returns every placeholder pattern that matches `text`. */
function findPlaceholders(text: string): string[] {
  return PLACEHOLDER_PATTERNS.filter((pattern) => pattern.test(text)).map(String);
}

/**
 * Serializes only the SIX STAGE OUTPUTS. The lead profile is excluded on
 * purpose: it is verbatim caller-supplied input (Req 1.4), so a placeholder-ish
 * token there came from the lead, not from the agent substituting a value.
 */
function serializeStageOutputs(artifact: RunArtifact): string {
  return JSON.stringify(
    ([1, 2, 3, 4, 5, 6] as const).map((n) => {
      const record = artifact.stages[`stage${n}` as keyof RunArtifact["stages"]];
      return { stage: n, output: record.output };
    }),
  );
}

/** The Stage 2 report, or `null` when Stage 2 itself degraded to `"unknown"`. */
function researchReport(artifact: RunArtifact): ResearchReport | null {
  const output = artifact.stages.stage2.output;
  return output === UNKNOWN ? null : output;
}

/** Asserts the full Property-37 degradation contract for one run. */
function assertDegradationContract(run: TotalFailureRun): void {
  const { artifact, events, toolbelt } = run;

  // (0) Retrieval was genuinely ATTEMPTED and genuinely failed — otherwise the
  //     property would pass vacuously on a pipeline that never tried.
  expect(toolbelt.searchCalls.length + toolbelt.fetchCalls.length).toBeGreaterThan(0);
  expect(artifact.fetchLedger).toEqual([]);

  // (2) The run reached a terminal, non-crashing status (Req 17.3).
  expect(["complete", "partial"]).toContain(artifact.status);

  // (3) Every research claim is unknown and unverified (Req 17.3, 5.1–5.3).
  const report = researchReport(artifact);
  if (report !== null) {
    for (const claim of report.claims) {
      expect(claim.claimText).toBe(UNKNOWN);
      expect(claim.verificationStatus).toBe(UNKNOWN);
      expect(claim.sourceUrl).toBe(UNKNOWN);
      expect(claim.retrievedAt).toBe(UNKNOWN);
      // A numeric figure needs its own ledgered source URL (Req 5.6); with an
      // empty ledger none can survive.
      expect(claim.numericFigures).toEqual([]);
    }
    // (4) No claim is verified when nothing was retrieved.
    expect(report.verifiedClaimCount).toBe(0);
  }

  // (5) Only the literal "unknown" was substituted — no placeholder anywhere in
  //     the six stage outputs (Req 17.6).
  const serialized = serializeStageOutputs(artifact);
  expect(findPlaceholders(serialized), `placeholder value(s) found in stage outputs`).toEqual(
    [],
  );

  // (6) The gaps are reported honestly (Req 5.7, 17.5).
  expect(artifact.unknownFieldReport.length).toBeGreaterThan(0);
  const substitutionEvents = events.filter((e) => e.type === "unknown_substitution");
  expect(substitutionEvents.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Deterministic case — the Fixed_Lead through the real pipeline
// ---------------------------------------------------------------------------

describe("Property 37: total retrieval failure produces only unknowns (Fixed_Lead)", () => {
  it("completes the real six-stage pipeline with unknowns and no placeholders", async () => {
    const run = await runWithTotalRetrievalFailure();

    assertDegradationContract(run);

    // All six stage records exist and reached a terminal state; a stage that
    // could not honour its contract without evidence degraded to
    // `failed` + `"unknown"` rather than inventing a value (Req 2.5, 17.6).
    for (const n of [1, 2, 3, 4, 5, 6] as const) {
      const record = run.artifact.stages[`stage${n}` as keyof RunArtifact["stages"]];
      expect(["complete", "failed"]).toContain(record.status);
      if (record.status === "failed") {
        expect(record.output).toBe(UNKNOWN);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Property — the contract holds for arbitrary leads
// ---------------------------------------------------------------------------

describe("Property 37: total retrieval failure (arbitrary leads)", () => {
  it("holds for arbitrary raw emails", async () => {
    await fc.assert(
      fc.asyncProperty(arbRawEmail, async (rawEmail) => {
        // The lead itself must not already carry a placeholder token, or the
        // scan would flag caller-supplied input echoed into an output rather
        // than a value the agent substituted.
        fc.pre(findPlaceholders(JSON.stringify(rawEmail)).length === 0);

        const run = await runWithTotalRetrievalFailure(rawEmail);
        assertDegradationContract(run);
      }),
      // Each case runs the REAL six stages, so the iteration count is kept low
      // deliberately; the contract is structural, not statistical.
      { numRuns: 5, endOnFailure: true },
    );
  }, 120_000);
});
