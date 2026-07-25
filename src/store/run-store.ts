/**
 * Run store interface, serialization helpers, and backend selection
 * (Req 16.1, 16.3, 16.4, 16.5).
 *
 * A `RunStore` persists a completed `RunArtifact` under its `runId` and reads
 * it back by id. Serialization goes through the same Zod schema used for LLM
 * and route validation (`runArtifactSchema`), so a store round-trip is exact:
 * `deserialize(serialize(a))` equals `a` (Req 16.4). Contract timestamps are
 * ISO-8601 strings precisely to keep that round-trip lossless.
 *
 * Backend selection is implicit, mirroring `env.ts`: when both Upstash vars are
 * present the durable Redis backend is used; otherwise the process falls back
 * to a development-only JSON file store under `.data/runs/`. The JSON fallback
 * does NOT survive a redeploy, so it does not satisfy Req 16.5 — only the
 * Upstash backend does.
 */

import type { RunArtifact, RunSummary, Maybe } from "../agent/contracts";
import { UNKNOWN } from "../agent/contracts";
import { runArtifactSchema } from "../agent/schemas";
import { getConfig } from "../lib/config/env";
import { JsonFileRunStore } from "./json-file-run-store";
import { UpstashRunStore } from "./upstash-run-store";

/**
 * Persistence component for {@link RunArtifact}s, keyed by `runId`.
 *
 * Implementations must serialize through {@link serializeArtifact} /
 * {@link deserializeArtifact} so that a store round-trip is exact (Req 16.4).
 */
export interface RunStore {
  /** Persists (or overwrites) the artifact under its `runId` (Req 16.1). */
  put(artifact: RunArtifact): Promise<void>;
  /** Returns the stored artifact, or `null` when the id is unknown (Req 16.3). */
  get(runId: string): Promise<RunArtifact | null>;
  /** Returns run summaries, newest first, capped at `limit` when provided. */
  list(limit?: number): Promise<RunSummary[]>;
  /** `false` for the JSON fallback; only the Upstash backend is durable (Req 16.5). */
  readonly isDurable: boolean;
}

// ---------------------------------------------------------------------------
// Serialization — the single round-trip path shared by every backend
// ---------------------------------------------------------------------------

/**
 * Validates the artifact against {@link runArtifactSchema} and returns its JSON
 * text. Validating on the way out guarantees only well-formed artifacts reach
 * the backend and keeps the round-trip exact (Req 16.4).
 */
export function serializeArtifact(artifact: RunArtifact): string {
  return JSON.stringify(runArtifactSchema.parse(artifact));
}

/**
 * Parses JSON text and validates it against {@link runArtifactSchema}, so a
 * value read back from a backend is a fully-typed {@link RunArtifact} equal to
 * the one originally serialized (Req 16.4).
 */
export function deserializeArtifact(json: string): RunArtifact {
  return runArtifactSchema.parse(JSON.parse(json));
}

/**
 * Derives the lightweight {@link RunSummary} used by `list()` from a full
 * artifact. The verified-claim count comes from the Stage 2 research report
 * when it produced output; a failed stage (`output === "unknown"`) yields `0`.
 */
export function toRunSummary(artifact: RunArtifact): RunSummary {
  const stage2Output = artifact.stages.stage2.output;
  const verifiedClaimCount =
    stage2Output === UNKNOWN ? 0 : stage2Output.verifiedClaimCount;

  const company: Maybe<string> = artifact.leadProfile.company;

  return {
    runId: artifact.runId,
    status: artifact.status,
    company,
    startedAt: artifact.startedAt,
    verifiedClaimCount,
  };
}

// ---------------------------------------------------------------------------
// Backend selection — implicit, mirrors env.ts run-store resolution
// ---------------------------------------------------------------------------

/**
 * Returns the {@link RunStore} implied by the environment. When the configured
 * backend is `upstash`, the durable Redis store is used; otherwise the
 * development-only JSON file store under `.data/runs/` is returned.
 */
export function createRunStore(): RunStore {
  const config = getConfig();

  if (config.runStoreBackend === "upstash") {
    // Backend selection is `upstash` only when both vars resolved (see env.ts),
    // so these are present; the check keeps the types honest and fails loudly
    // rather than silently degrading to the non-durable store (Req 16.5).
    if (
      config.upstashRedisRestUrl === undefined ||
      config.upstashRedisRestToken === undefined
    ) {
      throw new Error(
        "Upstash run store selected but UPSTASH_REDIS_REST_URL / " +
          "UPSTASH_REDIS_REST_TOKEN are not both set.",
      );
    }
    return new UpstashRunStore({
      url: config.upstashRedisRestUrl,
      token: config.upstashRedisRestToken,
    });
  }

  return new JsonFileRunStore();
}
