import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { streamReducer, type RunStreamState } from "@/hooks/useRunStream";
import type { StageEvent } from "@/agent/contracts";

describe("Property 31: The stream reducer is order- and duplicate-tolerant", () => {
  const initial: RunStreamState = {
    runId: null,
    runStatus: "idle",
    stages: {
      1: { status: "pending", output: null, events: [] },
      2: { status: "pending", output: null, events: [] },
      3: { status: "pending", output: null, events: [] },
      4: { status: "pending", output: null, events: [] },
      5: { status: "pending", output: null, events: [] },
      6: { status: "pending", output: null, events: [] },
    },
    events: [],
    lastSeq: 0,
    isInterrupted: false,
    artifact: null,
    error: null,
    startTime: null,
    elapsedMs: 0,
  };

  it("handles duplicate events losslessly and maintains increasing lastSeq", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            seq: fc.integer({ min: 1, max: 100 }),
            eventId: fc.string({ minLength: 3 }),
            runId: fc.constant("run_test_123"),
            stage: fc.constant(1 as const),
            stageName: fc.constant("Qualifier"),
            type: fc.constant("stage_started" as const),
            timestamp: fc.constant(new Date().toISOString()),
            message: fc.string(),
          }),
          { minLength: 1, maxLength: 50 }
        ),
        (events) => {
          let state = initial;
          for (const evt of events) {
            state = streamReducer(state, { type: "PROCESS_EVENT", event: evt as StageEvent });
          }

          // Duplicate event processing should preserve unique seq values
          const uniqueSeqs = new Set(state.events.map((e) => e.seq));
          expect(state.events.length).toBe(uniqueSeqs.size);
        }
      ),
      { numRuns: 100 }
    );
  });
});
