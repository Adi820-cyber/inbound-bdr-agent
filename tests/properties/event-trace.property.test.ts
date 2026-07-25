/**
 * Property 29 — The event trace covers every stage and every tool call.
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 11.6**
 *
 * Every lifecycle event flows through the orchestrator's single `emit`
 * chokepoint, which assigns a monotonic per-run `seq` and fans the event out to
 * BOTH the SSE sink (`onEvent`) and the artifact's `events` array. For an
 * arbitrary mix of succeeding and failing stages — each of which also emits a
 * `tool_call` event to model tool usage — this suite asserts:
 *
 *   - `seq` is `0, 1, 2, …` with no gaps and no duplicates (Req 11.6);
 *   - every executed stage emits a `stage_started` (Req 11.1) and exactly one
 *     terminal `stage_completed`|`stage_failed` (Req 11.3);
 *   - every executed stage's `tool_call` appears in the trace (Req 11.2);
 *   - the artifact's `events` array equals what `onEvent` received (Req 11.6).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StageEvent, StageNumber } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";

import {
  fakeStage,
  makeDeps,
  markerOutput,
  markerSchema,
  recordForStage,
} from "@tests/support/orchestrator-harness";

const ALL_STAGES = [1, 2, 3, 4, 5, 6] as StageNumber[];

const arbFailing = fc.subarray(ALL_STAGES);

describe("Property 29: the event trace covers every stage and tool call (Req 11.1, 11.2, 11.3, 11.6)", () => {
  it("emits monotonic, complete lifecycle + tool events mirrored into the artifact", async () => {
    await fc.assert(
      fc.asyncProperty(arbFailing, async (failing) => {
        const failSet = new Set(failing);
        const received: StageEvent[] = [];

        const stages = ALL_STAGES.map((n) =>
          fakeStage({
            stage: n,
            schema: markerSchema,
            run: (ctx) => {
              // Model a tool call for this stage (only on the first attempt so
              // the trace has a clean one-per-stage witness).
              if (ctx.attempt === 1) {
                ctx.emit({
                  stage: n,
                  stageName: `Stage ${n}`,
                  type: "tool_call",
                  message: `Stage ${n} tool call`,
                  toolCall: {
                    kind: "search",
                    urlOrQuery: `query-${n}`,
                    statusCode: 200,
                    retrievedAt: "2024-01-01T00:00:00.000Z",
                  },
                });
              }
              if (failSet.has(n)) throw new Error(`stage ${n} failed`);
              return markerOutput(n);
            },
          }),
        );

        const artifact = await runPipeline({
          onEvent: (e) => received.push(e),
          deps: makeDeps({ stages }),
        });

        // seq is 0..n-1, monotonic, unique.
        const seqs = received.map((e) => e.seq);
        expect(seqs).toEqual(received.map((_, i) => i));
        expect(new Set(seqs).size).toBe(seqs.length);

        // Per-stage lifecycle + tool-call coverage.
        for (const n of ALL_STAGES) {
          const forStage = received.filter((e) => e.stage === n);
          const started = forStage.filter((e) => e.type === "stage_started");
          const completed = forStage.filter((e) => e.type === "stage_completed");
          const failedEvents = forStage.filter((e) => e.type === "stage_failed");
          const toolCalls = forStage.filter((e) => e.type === "tool_call");

          expect(started.length).toBe(1);
          expect(toolCalls.length).toBeGreaterThanOrEqual(1);

          // Exactly one terminal event, matching the record status.
          expect(completed.length + failedEvents.length).toBe(1);
          if (failSet.has(n)) {
            expect(failedEvents.length).toBe(1);
            expect(recordForStage(artifact, n).status).toBe("failed");
          } else {
            expect(completed.length).toBe(1);
            expect(recordForStage(artifact, n).status).toBe("complete");
          }
        }

        // The artifact's event array equals what the SSE sink received.
        expect(artifact.events).toEqual(received);
      }),
      { numRuns: 100 },
    );
  });
});
