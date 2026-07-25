/**
 * Durable Upstash Redis run store (Req 16.1, 16.2, 16.3, 16.4, 16.5).
 *
 * Persists each artifact as the JSON produced by {@link serializeArtifact}
 * under the key `run:{runId}`, and tracks a capped `runs:index` sorted set
 * scored by the run's start time so {@link list} can return summaries newest
 * first without scanning every key. Reads go back through
 * {@link deserializeArtifact}, so a write→read round-trip is exact (Req 16.4).
 *
 * `isDurable` is `true`: Redis lives outside the (ephemeral) container
 * filesystem, so stored runs survive a redeploy — the only backend that
 * satisfies Req 16.5.
 *
 * Access is via the `@upstash/redis` REST SDK rather than raw `fetch`, so this
 * module under `src/store` does not itself perform egress; the SDK owns the
 * HTTP transport to the Upstash REST endpoint.
 */

import { Redis } from "@upstash/redis";

import type { RunArtifact, RunSummary } from "../agent/contracts";
import {
  deserializeArtifact,
  serializeArtifact,
  toRunSummary,
  type RunStore,
} from "./run-store";

/** Redis key prefix for a single stored artifact. */
const RUN_KEY_PREFIX = "run:";
/** Sorted set that indexes runs by start time so `list()` avoids a key scan. */
const INDEX_KEY = "runs:index";

/** Builds the per-run key; a blank id has no valid key and is rejected. */
function runKey(runId: string): string {
  if (runId.length === 0) {
    throw new Error("Invalid runId for Upstash run store: empty string");
  }
  return `${RUN_KEY_PREFIX}${runId}`;
}

/** Turns an ISO-8601 start timestamp into a numeric sorted-set score. */
function scoreForStartedAt(startedAt: string): number {
  const millis = Date.parse(startedAt);
  return Number.isNaN(millis) ? 0 : millis;
}

export interface UpstashRunStoreOptions {
  /** Upstash REST URL; defaults to the value resolved from config. */
  url: string;
  /** Upstash REST token; defaults to the value resolved from config. */
  token: string;
}

export class UpstashRunStore implements RunStore {
  readonly isDurable = true;

  private readonly redis: Redis;

  /**
   * @param options REST URL and token for the Upstash database. Distinct
   *   instances constructed from the same credentials share the underlying
   *   store, which is what makes cross-instance round-trips durable (Req 16.5).
   */
  constructor(options: UpstashRunStoreOptions) {
    this.redis = new Redis({ url: options.url, token: options.token });
  }

  /**
   * Persists (or overwrites) the artifact and records it in the newest-first
   * index. The `@upstash/redis` SDK JSON-encodes string values, so the artifact
   * is stored as the exact text from {@link serializeArtifact} (Req 16.1).
   */
  async put(artifact: RunArtifact): Promise<void> {
    const json = serializeArtifact(artifact);
    await this.redis.set(runKey(artifact.runId), json);
    await this.redis.zadd(INDEX_KEY, {
      score: scoreForStartedAt(artifact.startedAt),
      member: artifact.runId,
    });
  }

  /** Reads and validates the stored artifact; returns `null` for an unknown id (Req 16.3). */
  async get(runId: string): Promise<RunArtifact | null> {
    const stored = await this.redis.get<string>(runKey(runId));
    if (stored === null || stored === undefined) {
      return null;
    }
    // The SDK returns the decoded string; hand it straight to the shared parser
    // so the round-trip stays exact (Req 16.4).
    const json = typeof stored === "string" ? stored : JSON.stringify(stored);
    return deserializeArtifact(json);
  }

  /**
   * Returns run summaries newest first, capped at `limit` when provided. The
   * index sorted set is scored by start time, so a descending range yields the
   * ordering directly; an id present in the index but missing its artifact
   * (e.g. evicted) is skipped rather than throwing.
   */
  async list(limit?: number): Promise<RunSummary[]> {
    const stop = limit === undefined ? -1 : Math.max(limit - 1, 0);
    const runIds = await this.redis.zrange<string[]>(INDEX_KEY, 0, stop, {
      rev: true,
    });

    if (runIds.length === 0) {
      return [];
    }

    const summaries: RunSummary[] = [];
    for (const runId of runIds) {
      const artifact = await this.get(runId);
      if (artifact !== null) {
        summaries.push(toRunSummary(artifact));
      }
    }

    return summaries;
  }
}
