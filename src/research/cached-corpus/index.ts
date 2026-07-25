/**
 * Cached-corpus fallback chain for Stage 4 case-study matching (Req 7.6, 7.7).
 *
 * The Cached_Corpus is a committed, timestamped snapshot of FlytBase public
 * case-study pages used ONLY when live retrieval fails. It lives beside this
 * module as `manifest.json`, carrying:
 *   - `snapshotAt`: an ISO-8601 timestamp recording when the snapshot was taken,
 *   - `records`:    the frozen {@link CaseStudyRecord} set.
 *
 * The manifest stores each record's `verificationStatus` as `"verified"` (that
 * is what the field looked like when the snapshot was captured), but the loader
 * NEVER serves that value: any record returned from the cache is stamped
 * `"stale"` (Req 7.6), because it did not come from a live fetch during this
 * run. The `retrievedAt` on each record therefore points at the snapshot time,
 * not "now".
 *
 * This module deliberately owns only two responsibilities:
 *   1. {@link loadCachedCorpus} — read the snapshot and return stale records
 *      (or `null` when no snapshot is available).
 *   2. {@link resolveCaseStudyCorpus} — the fallback-chain decision the Stage 4
 *      matcher (task 12.3) calls after attempting a live enumerate+extract:
 *        live records present  → use them  (provenance `"live"`),
 *        live empty + cache    → stale records + a StageEvent carrying
 *                                `snapshotAt` (provenance `"cached"`),
 *        live empty + no cache → signal the matcher to fail the stage with
 *                                `matchResult` `"unknown"` (provenance
 *                                `"unavailable"`).
 *
 * The JSON snapshot is imported directly (the project's tsconfig enables
 * `resolveJsonModule`), so no filesystem access is needed at runtime and the
 * loader is safe to call from any environment (server or edge).
 */

import {
  UNKNOWN,
  type CaseStudyRecord,
  type IsoTimestamp,
  type Maybe,
  type StageEvent,
  type StageNumber,
} from "@/agent/contracts";

import manifest from "./manifest.json";

// ---------------------------------------------------------------------------
// Manifest shape and typed access
// ---------------------------------------------------------------------------

/** The on-disk shape of `manifest.json`. */
export interface CachedCorpusManifest {
  /** ISO-8601 timestamp recording when this snapshot was captured. */
  snapshotAt: IsoTimestamp;
  /** The frozen case-study records, stored with their capture-time status. */
  records: CaseStudyRecord[];
}

/** The loaded snapshot: a timestamp plus records already stamped `"stale"`. */
export interface CachedCorpus {
  snapshotAt: IsoTimestamp;
  records: CaseStudyRecord[];
}

// `resolveJsonModule` widens JSON field types (e.g. `verificationStatus`
// becomes `string`); assert the on-disk shape once, here, at the boundary.
const CACHED_MANIFEST = manifest as unknown as CachedCorpusManifest;

/**
 * True when a usable snapshot is committed: a non-empty `snapshotAt` string and
 * at least one record. An empty or malformed manifest is treated as "no cache".
 */
function hasSnapshot(m: CachedCorpusManifest): boolean {
  return (
    typeof m?.snapshotAt === "string" &&
    m.snapshotAt.length > 0 &&
    Array.isArray(m?.records) &&
    m.records.length > 0
  );
}

/**
 * Return one record identical to `record` except with `verificationStatus`
 * forced to `"stale"` — a cached record was not live-fetched this run (Req 7.6).
 */
function asStale(record: CaseStudyRecord): CaseStudyRecord {
  return { ...record, verificationStatus: "stale" };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the committed cached corpus.
 *
 * @returns The snapshot timestamp and its records with every record's
 *          `verificationStatus` forced to `"stale"` (Req 7.6), or `null` when
 *          no snapshot is committed.
 */
export function loadCachedCorpus(): CachedCorpus | null {
  if (!hasSnapshot(CACHED_MANIFEST)) return null;

  return {
    snapshotAt: CACHED_MANIFEST.snapshotAt,
    records: CACHED_MANIFEST.records.map(asStale),
  };
}

// ---------------------------------------------------------------------------
// Fallback-chain resolution (Req 7.6, 7.7)
// ---------------------------------------------------------------------------

/** Provenance of the corpus the matcher ends up using. Mirrors `MatchResult`. */
export type CorpusProvenance = "live" | "cached" | "unavailable";

/** The subset of a `StageEvent` a caller supplies; the harness fills the rest. */
type EmitFn = (event: Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">) => void;

/** Stage attribution for the fallback StageEvent. Defaults to Stage 4 (Matcher). */
const DEFAULT_STAGE_INFO: { stage: StageNumber; stageName: string } = {
  stage: 4,
  stageName: "Matcher",
};

/**
 * The outcome of the fallback chain. `records` is what the matcher should score;
 * `provenance` and `cachedSnapshotAt` populate the corresponding `MatchResult`
 * fields; `shouldFailStage` is `true` only when neither a live nor a cached
 * corpus is available, in which case the matcher must fail the stage and set
 * `matchResult` to `"unknown"` (Req 7.7).
 */
export interface CorpusResolution {
  records: CaseStudyRecord[];
  provenance: CorpusProvenance;
  /** The snapshot timestamp when `provenance === "cached"`, else `"unknown"`. */
  cachedSnapshotAt: Maybe<IsoTimestamp>;
  /** `true` only for `provenance === "unavailable"` (Req 7.7). */
  shouldFailStage: boolean;
}

/** Options for {@link resolveCaseStudyCorpus}; all collaborators are injectable. */
export interface ResolveCorpusOptions {
  /** Emits the fallback StageEvent when the cached corpus is served (Req 7.6). */
  emit?: EmitFn;
  /** Stage attribution for the emitted event. Defaults to Stage 4 (Matcher). */
  stageInfo?: { stage: StageNumber; stageName: string };
  /** Cache loader override for tests. Defaults to {@link loadCachedCorpus}. */
  loadCache?: () => CachedCorpus | null;
}

/**
 * Resolve the case-study corpus for Stage 4, applying the fallback chain.
 *
 * Call this with the result of the live enumerate+extract step:
 *   - If `liveRecords` is non-empty, the live corpus is used as-is
 *     (`provenance: "live"`) and no cache is touched.
 *   - If `liveRecords` is empty (live enumeration/extraction failed or found
 *     nothing) and a snapshot is committed, the cached records are returned
 *     stamped `"stale"`, `cachedSnapshotAt` carries the snapshot timestamp, and
 *     — when an `emit` is supplied — one StageEvent records the fallback and its
 *     snapshot timestamp (Req 7.6).
 *   - If `liveRecords` is empty and no snapshot exists, `shouldFailStage` is
 *     `true` so the matcher fails the stage with `matchResult` `"unknown"`
 *     (Req 7.7).
 *
 * TOTAL: never throws. A missing `emit` simply skips the notification.
 */
export function resolveCaseStudyCorpus(
  liveRecords: readonly CaseStudyRecord[],
  options: ResolveCorpusOptions = {},
): CorpusResolution {
  // Live corpus wins whenever it produced anything.
  if (Array.isArray(liveRecords) && liveRecords.length > 0) {
    return {
      records: [...liveRecords],
      provenance: "live",
      cachedSnapshotAt: UNKNOWN,
      shouldFailStage: false,
    };
  }

  // Live failed / empty → try the committed snapshot.
  const loadCache = options.loadCache ?? loadCachedCorpus;
  const cached = loadCache();

  if (cached === null) {
    // No live corpus and no cache: the matcher must fail the stage (Req 7.7).
    return {
      records: [],
      provenance: "unavailable",
      cachedSnapshotAt: UNKNOWN,
      shouldFailStage: true,
    };
  }

  // Cached fallback: stale records + a StageEvent carrying the snapshot time.
  const stageInfo = options.stageInfo ?? DEFAULT_STAGE_INFO;
  options.emit?.({
    stage: stageInfo.stage,
    stageName: stageInfo.stageName,
    type: "reasoning",
    message:
      "Live case-study retrieval failed; served the cached corpus snapshot " +
      `taken at ${cached.snapshotAt}. All ${cached.records.length} records are marked "stale".`,
    inputSummary: `cachedSnapshotAt=${cached.snapshotAt}`,
  });

  return {
    records: cached.records,
    provenance: "cached",
    cachedSnapshotAt: cached.snapshotAt,
    shouldFailStage: false,
  };
}
