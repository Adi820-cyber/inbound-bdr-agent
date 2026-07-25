/**
 * Unknown-field report builder (Req 5.7, 17.5).
 *
 * After all six stages have run, the orchestrator calls
 * {@link buildUnknownFieldReport} to deep-walk every stage output and collect
 * each field whose value is exactly the `"unknown"` literal. The result
 * populates `RunArtifact.unknownFieldReport`, which drives the Limitations
 * panel in the Run Console, and one `unknown_substitution` StageEvent is
 * emitted per reported substitution (Req 17.5).
 *
 * Design constraints (Property 14):
 *  - The report names PRECISELY the stage-output fields equal to `"unknown"` —
 *    no unknown field omitted, no reported field holding a real value.
 *  - The walk is deterministic: object keys are visited in insertion order and
 *    arrays in index order, so the same artifact always yields the same report.
 *  - The walk is total: it never throws, regardless of the shape of the data.
 */

import {
  UNKNOWN,
  type Maybe,
  type ResearchDimension,
  type RunArtifact,
  type StageEvent,
  type StageNumber,
} from "./contracts";

/** One entry in `RunArtifact.unknownFieldReport`. */
export interface UnknownFieldReportEntry {
  /** The research dimension when the unknown lives under a Stage 2 claim, else `"unknown"`. */
  dimension: Maybe<ResearchDimension>;
  /** Dot/bracket path to the unknown field, rooted at the stage key (e.g. `stage2.claims[0].claimText`). */
  field: string;
  /** Human-readable explanation of why the field is unknown. */
  reason: string;
}

export type UnknownFieldReport = UnknownFieldReportEntry[];

/** The subset of `StageEvent` a caller emits; the run loop fills seq/id/runId/timestamp. */
type EmittableEvent = Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">;

type EmitFn = (event: EmittableEvent) => void;

const RESEARCH_DIMENSIONS: ReadonlySet<string> = new Set<ResearchDimension>([
  "org_structure",
  "budget_signals",
  "recent_news",
  "leadership_language",
  "positioning",
]);

/** The stage keys of `RunArtifact.stages`, in stage order. */
const STAGE_KEYS = [
  "stage1",
  "stage2",
  "stage3",
  "stage4",
  "stage5",
  "stage6",
] as const;

type StageKey = (typeof STAGE_KEYS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResearchDimension(value: unknown): value is ResearchDimension {
  return typeof value === "string" && RESEARCH_DIMENSIONS.has(value);
}

/**
 * Recursively collects every field equal to the `"unknown"` literal into `sink`.
 *
 * `dimension` carries the enclosing Stage 2 research dimension: when the walk
 * enters an object that declares its own `dimension` (i.e. a `ResearchClaim`),
 * that dimension flows down to all of its descendant unknowns.
 */
function collectUnknowns(
  value: unknown,
  path: string,
  dimension: Maybe<ResearchDimension>,
  sink: UnknownFieldReportEntry[],
): void {
  if (value === UNKNOWN) {
    sink.push({
      dimension,
      field: path,
      reason: `Field "${path}" resolved to the unknown marker; no verified value was available.`,
    });
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectUnknowns(value[i], `${path}[${i}]`, dimension, sink);
    }
    return;
  }

  if (isPlainObject(value)) {
    // A ResearchClaim declares its own dimension; adopt it for descendants.
    const nextDimension = isResearchDimension(value.dimension)
      ? value.dimension
      : dimension;
    for (const key of Object.keys(value)) {
      collectUnknowns(value[key], `${path}.${key}`, nextDimension, sink);
    }
    return;
  }

  // Primitives that are not the unknown marker contribute nothing.
}

/**
 * Walks every stage output in the run artifact and returns the set of fields
 * whose value is exactly `"unknown"`. When an `emit` callback is supplied, one
 * `unknown_substitution` StageEvent is emitted per reported entry (Req 17.5).
 *
 * When an entire stage output is `"unknown"` (the stage failed), the whole
 * stage is recorded as a single entry rather than being walked.
 *
 * Deterministic and total: the walk never throws and always produces the same
 * report for the same artifact.
 */
export function buildUnknownFieldReport(
  stages: RunArtifact["stages"],
  emit?: EmitFn,
): UnknownFieldReport {
  const report: UnknownFieldReportEntry[] = [];

  for (const key of STAGE_KEYS) {
    const record = stages[key as StageKey];
    if (record === undefined || record === null) continue;

    const stageEntries: UnknownFieldReportEntry[] = [];

    if (record.output === UNKNOWN) {
      // The whole stage failed: record it as one entry (Req 2.5).
      const failureReason =
        record.failureReason !== undefined && record.failureReason !== UNKNOWN
          ? record.failureReason
          : "output unavailable";
      stageEntries.push({
        dimension: UNKNOWN,
        field: `${key}.output`,
        reason: `Stage ${record.stage} (${record.stageName}) did not produce an output: ${failureReason}.`,
      });
    } else {
      collectUnknowns(record.output, key, UNKNOWN, stageEntries);
    }

    for (const entry of stageEntries) {
      report.push(entry);
      emit?.({
        stage: record.stage as StageNumber,
        stageName: record.stageName,
        type: "unknown_substitution",
        message: `Unknown marker substituted for "${entry.field}": ${entry.reason}`,
        substitutedField: entry.field,
      });
    }
  }

  return report;
}
