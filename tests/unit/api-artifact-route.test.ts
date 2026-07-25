/**
 * Unit tests — GET /api/runs/[runId] (Req 16.2, 16.3).
 *
 * The route is a thin read-through over the run store: it resolves the dynamic
 * `runId` from the awaited `context.params`, asks `createRunStore().get(runId)`
 * for the artifact, and maps the three possible outcomes onto status codes —
 * 200 with the artifact JSON when present, 404 when the store resolves `null`
 * (an unknown id, Req 16.3), and 500 when the store itself throws.
 *
 * The store module is mocked so no backend (Upstash REST or the JSON file
 * fallback) is constructed and no env is read: the assertions are about the
 * route's mapping, not about persistence, which task 16 covers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Stub returned by the mocked `createRunStore()`; re-armed per test. */
const storeStub = {
  get: vi.fn(),
  put: vi.fn(),
  list: vi.fn(),
  isDurable: false,
};

vi.mock("@/store/run-store", () => ({
  createRunStore: () => storeStub,
}));

// Imported after the mock is registered so the route binds the stub.
const { GET } = await import("@/app/api/runs/[runId]/route");

/** Minimal stand-in for the request; the route never reads it. */
function makeRequest(runId: string) {
  return new Request(`http://localhost/api/runs/${runId}`) as never;
}

/** The route awaits `context.params`, so params must be a promise. */
function makeContext(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

/** Small artifact-shaped payload; the route echoes whatever the store returns. */
const storedArtifact = {
  schemaVersion: 1,
  runId: "run_KNOWN",
  status: "complete",
};

describe("GET /api/runs/[runId]", () => {
  beforeEach(() => {
    storeStub.get.mockReset();
  });

  it("returns 200 with the stored artifact for a known run id", async () => {
    storeStub.get.mockResolvedValue(storedArtifact);

    const response = await GET(makeRequest("run_KNOWN"), makeContext("run_KNOWN"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(storedArtifact);
    expect(storeStub.get).toHaveBeenCalledWith("run_KNOWN");
  });

  it("returns 404 when the store has no artifact for the id", async () => {
    storeStub.get.mockResolvedValue(null);

    const response = await GET(
      makeRequest("run_UNKNOWN"),
      makeContext("run_UNKNOWN"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Run not found" });
  });

  it("returns 500 when the store throws", async () => {
    storeStub.get.mockRejectedValue(new Error("redis unreachable"));

    const response = await GET(makeRequest("run_BOOM"), makeContext("run_BOOM"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "redis unreachable" });
  });

  it("returns 400 when the dynamic segment resolves empty", async () => {
    const response = await GET(makeRequest(""), makeContext(""));

    expect(response.status).toBe(400);
    expect(storeStub.get).not.toHaveBeenCalled();
  });
});
