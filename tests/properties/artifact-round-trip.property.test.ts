/**
 * Property 34 — Run artifact serialization round-trips.
 *
 * **Validates: Requirements 16.1, 16.2, 16.4**
 *
 * A stored `RunArtifact` must survive a store round-trip byte-for-value: the
 * value read back equals the value written. This suite asserts that at two
 * layers:
 *
 *   1. Serialization purity — for any `RunArtifact` from `arbRunArtifact`,
 *      `deserializeArtifact(serializeArtifact(a))` deep-equals `a`. Both helpers
 *      run the artifact through `runArtifactSchema`, so this proves the schema
 *      is lossless over the whole generated input space (Req 16.4).
 *   2. Backend round-trip — the `JsonFileRunStore` writing to a real temp
 *      directory: `put(a)` then `get(a.runId)` returns a deep-equal artifact
 *      (Req 16.1). The artifact's `runId` is replaced with a filesystem-safe id
 *      so the store's own path-safety guard is not the thing under test here.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunArtifact } from "@/agent/contracts";
import {
  deserializeArtifact,
  serializeArtifact,
} from "@/store/run-store";
import { JsonFileRunStore } from "@/store/json-file-run-store";

import { arbRunArtifact } from "./arbitraries";

/** Filesystem-safe run id: no separators, no `..`, never empty. */
const arbSafeRunId: fc.Arbitrary<string> = fc.uuid().map((s) => `run-${s}`);

/** An artifact whose `runId` is safe for a one-file-per-run store. */
const arbStorableArtifact: fc.Arbitrary<RunArtifact> = fc
  .tuple(arbRunArtifact, arbSafeRunId)
  .map(([artifact, runId]) => ({ ...artifact, runId }));

/**
 * Deep-clones a value, collapsing negative zero to positive zero. JSON has no
 * representation for `-0` (`JSON.stringify(-0) === "0"`), so any store whose
 * wire format is JSON necessarily reads `-0` back as `0`. That numeric identity
 * is the one value the round-trip cannot preserve, and it never occurs in a real
 * artifact (scores, weights, counts). Canonicalizing both sides keeps the
 * fidelity check strict for everything else — strings, unicode, structure, and
 * every ordinary number.
 */
function canonicalizeNegativeZero<T>(value: T): T {
  if (typeof value === "number") {
    return (Object.is(value, -0) ? 0 : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeNegativeZero) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = canonicalizeNegativeZero(inner);
    }
    return out as T;
  }
  return value;
}

describe("Property 34 — run artifact serialization round-trips", () => {
  it("deserialize(serialize(a)) deep-equals a for any RunArtifact", () => {
    fc.assert(
      fc.property(arbRunArtifact, (artifact) => {
        const restored = deserializeArtifact(serializeArtifact(artifact));
        expect(restored).toEqual(canonicalizeNegativeZero(artifact));
      }),
    );
  });

  describe("JsonFileRunStore end-to-end", () => {
    let baseDir: string;
    let store: JsonFileRunStore;

    beforeAll(async () => {
      baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-store-roundtrip-"));
      store = new JsonFileRunStore(baseDir);
    });

    afterAll(async () => {
      await fs.rm(baseDir, { recursive: true, force: true });
    });

    it(
      "put(a) then get(a.runId) returns a deep-equal artifact",
      async () => {
        await fc.assert(
          fc.asyncProperty(arbStorableArtifact, async (artifact) => {
            await store.put(artifact);
            const restored = await store.get(artifact.runId);
            expect(restored).toEqual(canonicalizeNegativeZero(artifact));
          }),
          { numRuns: 25 },
        );
      },
      30_000,
    );
  });
});
