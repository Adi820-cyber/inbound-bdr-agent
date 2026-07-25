/**
 * Property 32 — Missing environment variables fail the run by name.
 *
 * **Validates: Requirements 14.4**
 *
 * The run's first action is the pre-stage env-validation guard. When a required
 * variable is missing, that guard throws an `EnvValidationError` naming the
 * offending variable (name only, never its value). The orchestrator must then:
 *
 *   - short-circuit the run to status `failed`;
 *   - emit a `validation_error` event whose message names the missing variable;
 *   - run NO stage (every stage record stays `pending` with `"unknown"` output).
 *
 * For an arbitrary variable name, this suite injects a `validateEnv` that throws
 * an `EnvValidationError` for that variable and asserts all three outcomes.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StageEvent, StageNumber } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";
import { EnvValidationError } from "@/lib/config/env";

import {
  fakeStage,
  makeDeps,
  markerOutput,
  markerSchema,
  recordForStage,
} from "@tests/support/orchestrator-harness";

const ALL_STAGES = [1, 2, 3, 4, 5, 6] as StageNumber[];

/** Realistic env-var names: non-empty upper-snake identifiers. */
const arbVariableName = fc
  .stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
  .filter((s) => s.length > 0);

describe("Property 32: missing environment variables fail the run by name (Req 14.4)", () => {
  it("short-circuits to failed, names the variable, and runs no stage", async () => {
    await fc.assert(
      fc.asyncProperty(arbVariableName, async (variableName) => {
        const received: StageEvent[] = [];
        let anyStageRan = false;

        const stages = ALL_STAGES.map((n) =>
          fakeStage({
            stage: n,
            schema: markerSchema,
            run: () => {
              anyStageRan = true;
              return markerOutput(n);
            },
          }),
        );

        const validateEnv = () => {
          throw new EnvValidationError(
            `Missing required environment variable ${variableName}.`,
            variableName,
          );
        };

        const artifact = await runPipeline({
          onEvent: (e) => received.push(e),
          deps: makeDeps({ stages, validateEnv }),
        });

        // Run failed, no stage ran.
        expect(artifact.status).toBe("failed");
        expect(anyStageRan).toBe(false);

        // A validation_error event names the offending variable.
        const validationErrors = received.filter((e) => e.type === "validation_error");
        expect(validationErrors.length).toBeGreaterThanOrEqual(1);
        expect(
          validationErrors.some((e) => e.message.includes(variableName)),
        ).toBe(true);

        // Every stage record stayed pending / unknown.
        for (const n of ALL_STAGES) {
          const record = recordForStage(artifact, n);
          expect(record.status).toBe("pending");
          expect(record.output).toBe(UNKNOWN);
          expect(record.attempts).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
