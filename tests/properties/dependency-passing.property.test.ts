/**
 * Property 2 — Stages receive exactly their declared dependencies.
 *
 * **Validates: Requirements 2.3**
 *
 * The orchestrator builds each stage's `ctx.upstream` from that stage's
 * declared `dependsOn` array and nothing else (the dependency graph is data,
 * not control flow). For arbitrary `dependsOn` sets — each drawn only from the
 * slots produced by strictly-earlier stages — this suite asserts, from inside
 * every stage's `run`, that:
 *
 *   1. `Object.keys(ctx.upstream)` equals the stage's declared `dependsOn` set
 *      (no missing slot, and — crucially — no extra slot it did not declare).
 *   2. Each declared slot carries EXACTLY the output the producing stage
 *      returned (here every upstream stage succeeds, so no slot is degraded).
 *
 * All six stages succeed, so a declared dependency is always the real upstream
 * output; the failure-degradation half of the contract is covered by
 * Property 3 (failure-continuation).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StageContext, StageNumber } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";

import {
  fakeStage,
  makeDeps,
  markerOutput,
  markerSchema,
  producerKeysBefore,
} from "@tests/support/orchestrator-harness";

type UpstreamKey = keyof StageContext["upstream"];

/** For each stage 2..6, an arbitrary subset of the slots produced before it. */
const arbDependsOn = fc.tuple(
  fc.constant<UpstreamKey[]>([]), // stage 1 has no producers before it
  fc.subarray(producerKeysBefore(2)),
  fc.subarray(producerKeysBefore(3)),
  fc.subarray(producerKeysBefore(4)),
  fc.subarray(producerKeysBefore(5)),
  fc.subarray(producerKeysBefore(6)),
);

describe("Property 2: stages receive exactly their declared dependencies (Req 2.3)", () => {
  it("passes each stage exactly its declared upstream slots, with the producing stage's output", async () => {
    await fc.assert(
      fc.asyncProperty(arbDependsOn, async (dependsOnByIndex) => {
        // Records, per stage, the exact upstream object the stage was handed.
        const seen: Partial<Record<StageNumber, Record<string, unknown>>> = {};

        const stages = ([1, 2, 3, 4, 5, 6] as StageNumber[]).map((n) => {
          const dependsOn = dependsOnByIndex[n - 1] as UpstreamKey[];
          return fakeStage({
            stage: n,
            dependsOn,
            schema: markerSchema,
            run: (ctx) => {
              seen[n] = { ...ctx.upstream };
              return markerOutput(n);
            },
          });
        });

        await runPipeline({ onEvent: () => {}, deps: makeDeps({ stages }) });

        for (const n of [1, 2, 3, 4, 5, 6] as StageNumber[]) {
          const declared = (dependsOnByIndex[n - 1] as UpstreamKey[]).slice().sort();
          const received = seen[n] ?? {};
          const receivedKeys = Object.keys(received).sort();

          // 1. Exactly the declared slots — no missing, no extra.
          expect(receivedKeys).toEqual(declared);

          // 2. Each slot carries the producing stage's real output.
          for (const key of declared) {
            const producer = ({
              qualification: 1,
              research: 2,
              emails: 3,
              match: 4,
              gtm: 5,
            } as Record<UpstreamKey, StageNumber>)[key];
            expect(received[key]).toEqual(markerOutput(producer));
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
