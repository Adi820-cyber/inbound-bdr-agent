/**
 * Unit tests — POST /api/run (Req 1.6, 2.2).
 *
 * The trigger route owns exactly two responsibilities, and both are asserted
 * here:
 *
 *  1. Lead resolution at the HTTP boundary (Req 1.6): an absent/empty body is
 *     tolerated and forwarded as `rawEmail: undefined`, which is the signal the
 *     orchestrator turns into the fixed demo lead; a body carrying `rawEmail`
 *     is forwarded verbatim so an alternative inbound email can be run.
 *  2. Streaming transport (Req 2.2, 12.2): the response carries the SSE headers
 *     (`text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`)
 *     and each event the orchestrator hands to `onEvent` reaches the client as
 *     one SSE frame with an `id:`, a named `event:`, and a `data:` JSON payload.
 *
 * The orchestrator is mocked: `runPipeline` drives a couple of fake
 * `StageEvent`s through the injected `onEvent` sink and resolves. That keeps the
 * test about the route's framing (no LLM, no network, no env), and since the
 * route clears its 15-second heartbeat in `finally`, a resolved pipeline leaves
 * no timer behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StageEvent } from "@/agent/contracts";

/** Captures the options the route passes to the orchestrator. */
const runPipeline = vi.fn();

vi.mock("@/agent/orchestrator", () => ({
  runPipeline: (options: unknown) => runPipeline(options),
}));

// Imported after the mock is registered so the route binds the stub.
const { POST } = await import("@/app/api/run/route");

function stageEvent(seq: number, overrides: Partial<StageEvent> = {}): StageEvent {
  return {
    seq,
    eventId: `evt_run_TEST_${seq}`,
    runId: "run_TEST",
    stage: null,
    stageName: null,
    type: "run_started",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: `event ${seq}`,
    ...overrides,
  };
}

const emitted: StageEvent[] = [
  stageEvent(0),
  stageEvent(1, { stage: 1, stageName: "qualifier", type: "stage_started" }),
];

/** A pipeline that pushes `emitted` through the sink, then resolves. */
function emitThenResolve(options: any) {
  for (const event of emitted) options.onEvent(event);
  return Promise.resolve({ runId: "run_TEST" });
}

function makeRequest(body?: string) {
  return new Request("http://localhost/api/run", {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  }) as never;
}

/** Drains the SSE body and returns each frame's parsed `data:` payload. */
async function readSseData(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.includes("data: "))
    .map((frame) => {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(line!.slice("data: ".length));
    });
}

describe("POST /api/run", () => {
  beforeEach(() => {
    runPipeline.mockReset();
    runPipeline.mockImplementation(emitThenResolve);
  });

  it("responds with the SSE headers", async () => {
    const response = await POST(makeRequest(JSON.stringify({})));

    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    await response.text(); // drain so the stream is not left open
  });

  it("streams one SSE frame per orchestrator event", async () => {
    const response = await POST(makeRequest(JSON.stringify({})));

    const frames = await readSseData(response);

    expect(frames).toEqual(emitted);
  });

  it("labels each frame with the event's seq as id and its type as event name", async () => {
    const response = await POST(makeRequest(JSON.stringify({})));

    const text = await response.text();

    expect(text).toContain("id: 0\nevent: run_started\ndata: ");
    expect(text).toContain("id: 1\nevent: stage_started\ndata: ");
  });

  it("accepts an absent body and forwards no rawEmail (fixed lead)", async () => {
    const response = await POST(makeRequest());
    await response.text();

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline.mock.calls[0]![0].rawEmail).toBeUndefined();
    expect(typeof runPipeline.mock.calls[0]![0].onEvent).toBe("function");
  });

  it("forwards an alternative raw email from the body", async () => {
    const rawEmail = "From: cto@acme.io\nSubject: pricing\n\nWe need a demo.";

    const response = await POST(makeRequest(JSON.stringify({ rawEmail })));
    await response.text();

    expect(runPipeline.mock.calls[0]![0].rawEmail).toBe(rawEmail);
  });

  it("streams a stage_failed frame when the pipeline throws", async () => {
    runPipeline.mockImplementation(() => Promise.reject(new Error("pipeline blew up")));

    const response = await POST(makeRequest(JSON.stringify({})));
    const frames = (await readSseData(response)) as Array<Record<string, unknown>>;

    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("stage_failed");
    expect(frames[0]!.message).toBe("pipeline blew up");
  });
});
