/**
 * Unit tests — Stage 4 cached-corpus fallback branches (Task 11.8, Req 7.6, 7.7).
 *
 * The fallback chain in `src/research/cached-corpus/index.ts` has three exits:
 *   - LIVE:        live records present → provenance "live", stage proceeds.
 *   - CACHED:      live empty + committed snapshot → records stamped "stale",
 *                  `cachedSnapshotAt` = the manifest snapshot time, and one
 *                  StageEvent carrying that timestamp is emitted (Req 7.6).
 *   - UNAVAILABLE: live empty + no snapshot → `shouldFailStage`, provenance
 *                  "unavailable", empty records, so the matcher fails the stage
 *                  with `matchResult` "unknown" (Req 7.7).
 *
 * These tests exercise all three branches against the REAL committed manifest,
 * plus `loadCachedCorpus()` directly (it must stamp every record "stale"), and
 * finally the Stage 4 matcher's `unavailableMatchResult` shape via its schema.
 */

import { describe, expect, it } from "vitest";

import type { CaseStudyRecord, StageEvent } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import {
  loadCachedCorpus,
  resolveCaseStudyCorpus,
} from "@/research/cached-corpus";
import manifest from "@/research/cached-corpus/manifest.json";
import { matchResultSchema } from "@/agent/schemas";

/** The event shape a caller of `resolveCaseStudyCorpus` receives via `emit`. */
type EmittedEvent = Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">;

/** The snapshot timestamp committed in the real manifest. */
const MANIFEST_SNAPSHOT_AT = manifest.snapshotAt as string;

/** A single fully-populated live record for the live-path assertions. */
function liveRecord(): CaseStudyRecord {
  return {
    sourceUrl: "https://www.flytbase.com/case-studies/live-example",
    title: "A freshly fetched case study",
    industry: "Mining & Metals",
    region: "Latin America",
    useCase: "Autonomous perimeter security patrols",
    namedPartner: UNKNOWN,
    statedResults: "Reduced manual patrol hours",
    verificationStatus: "verified",
    retrievedAt: "2025-06-01T12:00:00.000Z",
  };
}

describe("cached-corpus fallback chain (Req 7.6, 7.7)", () => {
  describe("loadCachedCorpus() stamps every record stale", () => {
    it("returns the manifest snapshot with all records marked stale", () => {
      const cached = loadCachedCorpus();

      // The committed manifest is present, so a snapshot must load.
      expect(cached).not.toBeNull();
      const corpus = cached!;

      expect(corpus.snapshotAt).toBe(MANIFEST_SNAPSHOT_AT);
      expect(corpus.records.length).toBeGreaterThan(0);
      expect(corpus.records.length).toBe(manifest.records.length);

      // Req 7.6 — no record served from the cache may keep its capture-time
      // "verified" status; every one is downgraded to "stale".
      for (const record of corpus.records) {
        expect(record.verificationStatus).toBe("stale");
      }
    });
  });

  describe("cached path (Req 7.6): live empty, committed snapshot present", () => {
    it("returns stale records, the snapshot timestamp, and emits a StageEvent carrying it", () => {
      const events: EmittedEvent[] = [];
      const recordingFn = (event: EmittedEvent) => {
        events.push(event);
      };

      const resolution = resolveCaseStudyCorpus([], { emit: recordingFn });

      // Provenance is "cached" and the stage must NOT fail.
      expect(resolution.provenance).toBe("cached");
      expect(resolution.shouldFailStage).toBe(false);

      // Every returned record is stamped "stale" (Req 7.6).
      expect(resolution.records.length).toBeGreaterThan(0);
      for (const record of resolution.records) {
        expect(record.verificationStatus).toBe("stale");
      }

      // `cachedSnapshotAt` equals the committed manifest snapshot timestamp.
      expect(resolution.cachedSnapshotAt).toBe(MANIFEST_SNAPSHOT_AT);

      // Exactly one StageEvent was emitted, and it carries the snapshot time.
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.stage).toBe(4);
      expect(event.message).toContain(MANIFEST_SNAPSHOT_AT);
      expect(event.inputSummary).toContain(MANIFEST_SNAPSHOT_AT);
    });

    it("does not require an emit function (notification is skipped when absent)", () => {
      const resolution = resolveCaseStudyCorpus([]);

      expect(resolution.provenance).toBe("cached");
      expect(resolution.shouldFailStage).toBe(false);
      expect(resolution.cachedSnapshotAt).toBe(MANIFEST_SNAPSHOT_AT);
    });
  });

  describe("no-cache path (Req 7.7): live empty, no snapshot available", () => {
    it("signals a stage failure with provenance unavailable and no records", () => {
      const events: EmittedEvent[] = [];
      const resolution = resolveCaseStudyCorpus([], {
        loadCache: () => null,
        emit: (event) => events.push(event),
      });

      // Req 7.7 — the matcher must fail the stage and set matchResult "unknown".
      expect(resolution.shouldFailStage).toBe(true);
      expect(resolution.provenance).toBe("unavailable");
      expect(resolution.records).toEqual([]);
      expect(resolution.cachedSnapshotAt).toBe(UNKNOWN);

      // No cached-fallback StageEvent is emitted when there is nothing to serve.
      expect(events).toHaveLength(0);
    });
  });

  describe("live path: live records present", () => {
    it("uses the live corpus as-is with provenance live and no stage failure", () => {
      const events: EmittedEvent[] = [];
      // A poisoned loadCache proves the cache is never consulted on the live path.
      const resolution = resolveCaseStudyCorpus([liveRecord()], {
        emit: (event) => events.push(event),
        loadCache: () => {
          throw new Error("cache must not be loaded when live records exist");
        },
      });

      expect(resolution.provenance).toBe("live");
      expect(resolution.shouldFailStage).toBe(false);
      expect(resolution.records).toHaveLength(1);
      expect(resolution.records[0].verificationStatus).toBe("verified");
      expect(resolution.cachedSnapshotAt).toBe(UNKNOWN);

      // The live path emits no fallback event.
      expect(events).toHaveLength(0);
    });
  });

  describe("Stage 4 matcher failure result shape (Req 7.7)", () => {
    it("the unavailable MatchResult is schema-valid with matchResult unknown", () => {
      // Mirror `unavailableMatchResult()` from stage-4-matcher.ts: the failure
      // output must still satisfy the MatchResult schema with everything unknown.
      const unavailable = {
        corpusSize: 0,
        rankedCorpus: [],
        winner: UNKNOWN,
        runnerUp: UNKNOWN,
        comparisonStatement: UNKNOWN,
        decidingDimensions: [],
        rubricWeights: {
          industry: 0.35,
          geography: 0.25,
          useCase: 0.3,
          partnerOverlap: 0.1,
        },
        corpusProvenance: "unavailable",
        cachedSnapshotAt: UNKNOWN,
      };

      const parsed = matchResultSchema.safeParse(unavailable);
      expect(parsed.success).toBe(true);
      expect(unavailable.winner).toBe(UNKNOWN);
      expect(unavailable.corpusProvenance).toBe("unavailable");
    });
  });
});
