/**
 * Development-only JSON file run store (Req 16.1, 16.3, 16.4).
 *
 * Writes one file per run under `.data/runs/{runId}.json`. Serialization goes
 * through {@link serializeArtifact} / {@link deserializeArtifact}, which run
 * every artifact through `runArtifactSchema`, so a write→read round-trip is
 * exact (Req 16.4).
 *
 * `isDurable` is `false`: this backend lives on the local (ephemeral) file
 * system and does NOT survive a redeploy, so it does not satisfy Req 16.5.
 * Only the Upstash backend is durable. The README and UI both say so.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { RunArtifact, RunSummary } from "../agent/contracts";
import {
  deserializeArtifact,
  serializeArtifact,
  toRunSummary,
  type RunStore,
} from "./run-store";

/** Default location for the JSON file store, relative to the process cwd. */
const DEFAULT_BASE_DIR = path.join(process.cwd(), ".data", "runs");

/** A `runId` that would escape the store directory is rejected outright. */
function assertSafeRunId(runId: string): void {
  if (runId.length === 0 || /[\\/]|\.\./.test(runId)) {
    throw new Error(`Invalid runId for JSON file store: ${JSON.stringify(runId)}`);
  }
}

export class JsonFileRunStore implements RunStore {
  readonly isDurable = false;

  private readonly baseDir: string;

  /**
   * @param baseDir Directory that holds one JSON file per run. Defaults to
   *   `.data/runs/` under the process cwd; overridable for tests.
   */
  constructor(baseDir: string = DEFAULT_BASE_DIR) {
    this.baseDir = baseDir;
  }

  private filePath(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.baseDir, `${runId}.json`);
  }

  /** Persists the artifact to `{runId}.json`, creating the directory as needed. */
  async put(artifact: RunArtifact): Promise<void> {
    const json = serializeArtifact(artifact);
    const target = this.filePath(artifact.runId);
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(target, json, "utf8");
  }

  /** Reads and validates `{runId}.json`; returns `null` for an unknown id (Req 16.3). */
  async get(runId: string): Promise<RunArtifact | null> {
    let json: string;
    try {
      json = await fs.readFile(this.filePath(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return deserializeArtifact(json);
  }

  /** Returns summaries for every stored run, newest first, capped at `limit`. */
  async list(limit?: number): Promise<RunSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.baseDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const json = await fs.readFile(path.join(this.baseDir, entry), "utf8");
      summaries.push(toRunSummary(deserializeArtifact(json)));
    }

    summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return limit === undefined ? summaries : summaries.slice(0, limit);
  }
}
