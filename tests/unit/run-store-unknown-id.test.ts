/**
 * Unit test — JsonFileRunStore.get(unknownRunId) returns null (Req 16.3).
 *
 * A read for an id that was never stored must resolve to `null` rather than
 * throwing. The store reads `.data/runs/{runId}.json`, so an absent id maps to a
 * missing file (ENOENT), which `get` swallows into `null`. A fresh temp
 * directory guarantees the id truly was never stored.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonFileRunStore } from "@/store/json-file-run-store";

describe("JsonFileRunStore.get on an unknown run id", () => {
  let baseDir: string;
  let store: JsonFileRunStore;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-store-unknown-"));
    store = new JsonFileRunStore(baseDir);
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("returns null for an id that was never stored", async () => {
    const result = await store.get("never-stored-run-id");
    expect(result).toBeNull();
  });
});
