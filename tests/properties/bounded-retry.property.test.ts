/**
 * Property 36 — Stage retries are bounded at three attempts.
 *
 * **Validates: Requirements 17.4**
 *
 * A stage whose output never validates (it always throws, or always returns
 * schema-invalid output) is re-invoked with feedback, but the orchestrator
 * caps the total at three invocations — the initial attempt plus two retries.
 * The final attempt may switch to the configured fallback model, which changes
 * WHICH model serves the attempt but never adds an invocation, so the bound
 * holds with a fallback configured too.
 *
 * For an arbitrary subset of always-failing stages (each failing by throw or by
 * invalid output), this suite counts the real `run` invocations per stage and
 * asserts:
 *
 *   - every failing stage is invoked at most 3 times, and — since it always
 *     fails — exactly 3 times;
 *   - its artifact `record.attempts` is `<= 3` (and equals the invocation
 *     count);
 *   - a surviving stage is invoked exactly once.
 *
 * A fallback model is configured on the injected LLM so the fallback-on-final-
 * attempt path is active; the bound must still hold.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StageNumber } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";
import { createStubLlmProvider } from "@tests/support/stub-llm";

import {
  fakeStage,
  makeDeps,
  markerOutput,
  markerSchema,
  recordForStage,
} from "@tests/support/orchestrator-harness";

const ALL_STAGES = [1, 2, 3, 4, 5, 6] as StageNumber[];
const MAX_STAGE_ATTEMPTS = 3;

const arbPlan = fc.record({
  failing: fc.subarray(ALL_STAGES, { minLength: 1 }),
  mode: fc.tuple(
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
    fc.constantFrom("throw", "invalid"),
  ),
});

describe("Property 36: stage retries are bounded at three attempts (Req 17.4)", () => {
  it("invokes an always-failing stage at most 3 times, fallback model included", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlan, async ({ failing, mode }) => {
        const failSet = new Set(failing);
        const invocations = new Map<StageNumber, number>();

        const stages = ALL_STAGES.map((n) =>
          fakeStage({
            stage: n,
            schema: markerSchema,
            run: () => {
              invocations.set(n, (invocations.get(n) ?? 0) + 1);
              if (failSet.has(n)) {
                if (mode[n - 1] === "throw") throw new Error(`stage ${n} always fails`);
                return { marker: 999 } as unknown as { marker: string };
              }
              return markerOutput(n);
            },
          }),
        );

        // Configure a fallback model so the final-attempt fallback path is live.
        const llm = createStubLlmProvider({ fallbackModel: "fallback-model" });

        const artifact = await runPipeline({
          onEvent: () => {},
          deps: makeDeps({ stages, llm }),
        });

        for (const n of ALL_STAGES) {
          const count = invocations.get(n) ?? 0;
          const record = recordForStage(artifact, n);

          expect(count).toBeLessThanOrEqual(MAX_STAGE_ATTEMPTS);
          expect(record.attempts).toBeLessThanOrEqual(MAX_STAGE_ATTEMPTS);
          expect(record.attempts).toBe(count);

          if (failSet.has(n)) {
            // Always fails ⇒ the budget is spent in full.
            expect(count).toBe(MAX_STAGE_ATTEMPTS);
          } else {
            // Succeeds on the first try ⇒ no retry.
            expect(count).toBe(1);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
