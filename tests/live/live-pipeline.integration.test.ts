/**
 * Opt-in LIVE integration tests (Task 20.3, Req 7.1, 16.5).
 *
 * These are the ONLY tests in the repository permitted real network egress, and
 * they are OFF BY DEFAULT. Two independent gates keep them harmless:
 *
 *  1. `describe.skipIf(!isLiveIntegrationEnabled())` — with `RUN_LIVE_INTEGRATION`
 *     unset, every live test is SKIPPED, so a plain `npx vitest run` never spends
 *     a single LLM request or search credit.
 *  2. `allowLiveNetwork()` — the global fetch guard (tests/setup/no-live-calls.ts)
 *     is explicitly opted out of INSIDE the live block only. The guard is
 *     re-armed before/after every test, so the opt-out cannot leak into the
 *     mocked suite.
 *
 * Why they exist: the mocked suite proves the pipeline's contracts, but nothing
 * mocked can prove that the real FlytBase case-studies index still yields a
 * crawlable corpus, or that a run artifact survives a round-trip through two
 * separate store clients (Req 16.5). Those facts can only be observed live.
 *
 * Quota discipline: the OpenRouter free tier allows ~50 requests/day and one
 * full run costs 15–25, so this file performs EXACTLY ONE live pipeline run in a
 * `beforeAll` and every assertion below reuses that single artifact.
 *
 * How to run (deliberately, on explicit request only — see the Live-run policy
 * in the spec's tasks.md):
 *
 *   # PowerShell
 *   $env:RUN_LIVE_INTEGRATION="1"; npx vitest run tests/live
 *
 * The process env must already carry the provider variables the run needs
 * (`LLM_PROVIDER`, the selected provider's key, `SEARCH_PROVIDER`, …); Vitest
 * does not load `.env.local` into `process.env`, so export them in the shell
 * first. A missing variable surfaces as an `EnvValidationError` naming it.
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { CaseStudyRecord, RunArtifact, StageEvent } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";
import { getConfig } from "@/lib/config/env";
import { createRunStore } from "@/store/run-store";

import {
  allowLiveNetwork,
  isLiveIntegrationEnabled,
  LIVE_INTEGRATION_ENV_FLAG,
} from "../setup/no-live-calls";

/** Resolved once at load time: the single gate for every live test below. */
const LIVE_ENABLED = isLiveIntegrationEnabled();

/** Generous ceilings — a live run crawls pages and calls a free-tier model. */
const LIVE_RUN_TIMEOUT_MS = 600_000;
const LIVE_STORE_TIMEOUT_MS = 60_000;

/** The seven content fields every extracted case-study record must carry (Req 7.1). */
const CASE_STUDY_FIELDS = [
  "sourceUrl",
  "title",
  "industry",
  "region",
  "useCase",
  "namedPartner",
  "statedResults",
] as const satisfies readonly (keyof CaseStudyRecord)[];

// ---------------------------------------------------------------------------
// Always-on meta test: proves the default-skipped guarantee itself
// ---------------------------------------------------------------------------

describe("live integration gating", () => {
  it("stays disabled unless the opt-in flag is set, so a normal run spends no quota", () => {
    const flag = process.env[LIVE_INTEGRATION_ENV_FLAG];
    const flagOff = flag === undefined || flag === "" || flag === "0" || flag === "false";

    expect(LIVE_ENABLED).toBe(!flagOff);

    if (flagOff) {
      // The fetch guard is armed in this (non-opted-out) test, so nothing here
      // can reach the network even by accident.
      expect(() => fetch("https://openrouter.ai/api/v1/chat/completions")).toThrow(
        /\[no-live-calls]/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The single live run, shared by every assertion below
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_ENABLED)("LIVE: end-to-end pipeline against real providers", () => {
  let artifact: RunArtifact;
  const events: StageEvent[] = [];

  beforeAll(async () => {
    // Opt out of the fetch guard for the duration of the live work. The setup
    // file re-arms the guard around each individual test, which is why the one
    // and only network-touching call happens here.
    allowLiveNetwork();

    // No `deps` at all — the production wiring: env-selected LLM + search
    // adapters, the real toolbelt, the real fetch ledger, the real run store.
    artifact = await runPipeline({
      onEvent: (event) => events.push(event),
    });
  }, LIVE_RUN_TIMEOUT_MS);

  it("produces six stage records, one per stage, each self-identifying", () => {
    const records = ([1, 2, 3, 4, 5, 6] as const).map(
      (n) => artifact.stages[`stage${n}` as keyof RunArtifact["stages"]],
    );

    expect(records).toHaveLength(6);
    records.forEach((record, index) => {
      expect(record.stage).toBe(index + 1);
      expect(record.sourceFile).toMatch(/^src\/agent\/stages\/stage-/);
      expect(["complete", "failed"]).toContain(record.status);
    });

    expect(["complete", "partial"]).toContain(artifact.status);
    expect(events.some((e) => e.type === "run_completed")).toBe(true);
  });

  it("ledgers every web request the live run made (Req 5.4, 7.8)", () => {
    expect(artifact.fetchLedger.length).toBeGreaterThan(0);
    for (const entry of artifact.fetchLedger) {
      expect(entry.runId).toBe(artifact.runId);
      expect(entry.requestedUrl.length).toBeGreaterThan(0);
    }
  });

  it("crawls a non-empty case-study corpus whose records carry all seven fields (Req 7.1)", () => {
    const stage4 = artifact.stages.stage4.output;
    // A stage that degraded carries the Unknown_Marker; that is a legitimate
    // outcome for a live run and is asserted as such rather than failing here.
    if (stage4 === UNKNOWN) {
      expect(artifact.status).toBe("partial");
      return;
    }

    expect(stage4.corpusSize).toBeGreaterThan(0);
    expect(stage4.rankedCorpus.length).toBeGreaterThan(0);
    for (const scored of stage4.rankedCorpus) {
      for (const field of CASE_STUDY_FIELDS) {
        // A `"unknown"` value still counts as present (Req 7.3); a MISSING key
        // is the failure this guards against.
        expect(scored.record[field]).toBeDefined();
      }
      expect(scored.record.sourceUrl.length).toBeGreaterThan(0);
    }
  });

  it(
    "round-trips the artifact through two separate store clients (Req 16.5)",
    async () => {
      allowLiveNetwork();

      // Two independently constructed clients — the durability question is
      // whether the bytes survive OUTSIDE the writing client's memory.
      const writer = createRunStore();
      const reader = createRunStore();

      // Only the durable (Upstash) backend satisfies Req 16.5; the JSON
      // fallback is dev-only and does not survive a redeploy.
      expect(writer.isDurable).toBe(getConfig().runStoreDurable);

      await writer.put(artifact);
      const readBack = await reader.get(artifact.runId);

      expect(readBack).not.toBeNull();
      expect(readBack?.runId).toBe(artifact.runId);
      expect(readBack).toEqual(artifact);
    },
    LIVE_STORE_TIMEOUT_MS,
  );
});
