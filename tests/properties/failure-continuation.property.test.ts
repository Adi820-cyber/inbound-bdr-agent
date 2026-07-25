/**
 * Property 3 — Run status and continuation under arbitrary stage failures.
 *
 * **Validates: Requirements 2.1, 2.4, 2.5**
 *
 * For an arbitrary subset of the six stages set to fail — either by throwing or
 * by returning schema-invalid output — the orchestrator must still:
 *
 *   1. Execute every stage, in fixed 1→6 order (Req 2.1). No failure aborts the
 *      run; the loop keeps going.
 *   2. Mark each failed stage `status: "failed"` with `output: "unknown"`
 *      (Req 2.5), and each surviving stage `status: "complete"`.
 *   3. Feed a failed stage's downstream dependents `"unknown"` for that slot
 *      (Req 2.5) while surviving slots carry the real output.
 *   4. Report run status `complete` iff NO stage failed, else `partial`
 *      (Req 2.4).
 *
 * Every stage depends on ALL slots produced before it, so each failed stage's
 * degradation is observable in every later stage's `ctx.upstream`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StageContext, StageNumber } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";

import {
  fakeStage,
  makeDeps,
  markerOutput,
  markerSchema,
  producerKeysBefore,
  PRODUCER_STAGE,
  recordForStage,
} from "@tests/support/orchestrator-harness";

type UpstreamKey = keyof StageContext["upstream"];

const ALL_STAGES = [1, 2, 3, 4, 5, 6] as StageNumber[];

/** Which stages fail, and how each failing stage fails. */
const arbFailurePlan = fc.record({
  failing: fc.subarray(ALL_STAGES),
  // For each stage, "throw" or "invalid" — only consulted when the stage fails.
  mode: fc.tuple(
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
  ),
});

describe("Property 3: run status and continuation under arbitrary failures (Req 2.1, 2.4, 2.5)", () => {
  it("runs all stages in order, degrades failures to unknown, and sets status accordingly", async () => {
    await fc.assert(
      fc.asyncProperty(arbFailurePlan, async ({ failing, mode }) => {
        const failSet = new Set(failing);
        const executionOrder: StageNumber[] = [];
        const seenUpstream: Partial<Record<StageNumber, Record<string, unknown>>> = {};

        const stages = ALL_STAGES.map((n) => {
          const dependsOn = producerKeysBefore(n);
          return fakeStage({
            stage: n,
            dependsOn,
            schema: markerSchema,
            run: (ctx) => {
              if (ctx.attempt === 1) {
                executionOrder.push(n);
                seenUpstream[n] = { ...ctx.upstream };
              }
              if (failSet.has(n)) {
                if (mode[n - 1] === "throw") {
                  throw new Error(`stage ${n} boom`);
                }
                // schema-invalid: `marker` must be a string.
                return { marker: 123 } as unknown as { marker: string };
              }
              return markerOutput(n);
            },
          });
        });

        const artifact = await runPipeline({
          onEvent: () => {},
          deps: makeDeps({ stages }),
        });

        // 1. Every stage executed, in fixed 1→6 order.
        expect(executionOrder).toEqual(ALL_STAGES);

        // 2. Per-stage status + degraded output.
        for (const n of ALL_STAGES) {
          const record = recordForStage(artifact, n);
          if (failSet.has(n)) {
            expect(record.status).toBe("failed");
            expect(record.output).toBe(UNKNOWN);
          } else {
            expect(record.status).toBe("complete");
            expect(record.output).toEqual(markerOutput(n));
          }
        }

        // 3. Downstream dependents see "unknown" for a failed slot, real output otherwise.
        for (const n of ALL_STAGES) {
          const received = seenUpstream[n] ?? {};
          for (const key of producerKeysBefore(n) as UpstreamKey[]) {
            const producer = PRODUCER_STAGE[key];
            if (failSet.has(producer)) {
              expect(received[key]).toBe(UNKNOWN);
            } else {
              expect(received[key]).toEqual(markerOutput(producer));
            }
          }
        }

        // 4. Run status: complete iff nothing failed, else partial.
        expect(artifact.status).toBe(failSet.size === 0 ? "complete" : "partial");
      }),
      { numRuns: 100 },
    );
  });
});
