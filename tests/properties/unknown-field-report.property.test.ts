/**
 * Property 14 — The unknown-field report is exactly the set of unknown values.
 *
 * **Validates: Requirements 5.7, 17.5**
 *
 * `buildUnknownFieldReport` deep-walks every stage output and reports precisely
 * the fields whose value is the `"unknown"` literal: no unknown omitted, no
 * reported field holding a real value. This test proves that by independently
 * deep-walking `artifact.stages` and comparing the set of unknown leaf paths the
 * walk finds against the field paths the builder reports.
 *
 * The independent walker mirrors the builder's path scheme exactly:
 *   - each stage is rooted at its key (`stage1` .. `stage6`), visited in order;
 *   - when a whole stage output is `"unknown"` (the stage failed), it is
 *     reported as ONE `stageN.output` entry rather than being walked;
 *   - otherwise the walk descends into the stage output, using `.key` for
 *     object members and `[i]` for array indices, and records the path of every
 *     value equal to the `"unknown"` marker.
 *
 * Only `record.output` is walked — the surrounding `StageRecord` bookkeeping
 * fields (`startedAt`, `failureReason`, ...) may themselves be `"unknown"` and
 * are deliberately ignored by both the builder and this walker.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN, type RunArtifact } from "@/agent/contracts";
import { buildUnknownFieldReport } from "@/agent/unknown-report";
import { arbRunArtifact } from "./arbitraries";

const STAGE_KEYS = [
  "stage1",
  "stage2",
  "stage3",
  "stage4",
  "stage5",
  "stage6",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Records the path of every leaf equal to the `"unknown"` marker. */
function walkValue(value: unknown, path: string, sink: string[]): void {
  if (value === UNKNOWN) {
    sink.push(path);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkValue(value[i], `${path}[${i}]`, sink);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      walkValue(value[key], `${path}.${key}`, sink);
    }
  }
}

/** Independently derive the exact set of unknown field paths the report should hold. */
function expectedUnknownPaths(stages: RunArtifact["stages"]): string[] {
  const paths: string[] = [];
  for (const key of STAGE_KEYS) {
    const record = stages[key];
    if (record === undefined || record === null) continue;
    if (record.output === UNKNOWN) {
      paths.push(`${key}.output`);
    } else {
      walkValue(record.output, key, paths);
    }
  }
  return paths;
}

describe("Property 14: the unknown-field report is exactly the set of unknown values", () => {
  it("reported field paths equal the independently-walked unknown leaf paths", () => {
    fc.assert(
      fc.property(arbRunArtifact, (artifact) => {
        const report = buildUnknownFieldReport(artifact.stages);
        const reportedFields = report.map((entry) => entry.field);
        const expectedFields = expectedUnknownPaths(artifact.stages);

        // No duplicate paths are produced (each leaf has a unique path).
        expect(new Set(reportedFields).size).toBe(reportedFields.length);

        // Exact set equality: no unknown omitted, no real-valued field reported.
        expect([...reportedFields].sort()).toEqual([...expectedFields].sort());

        // Every reported entry carries a non-empty reason (Req 17.5 provenance).
        for (const entry of report) {
          expect(typeof entry.reason).toBe("string");
          expect(entry.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
