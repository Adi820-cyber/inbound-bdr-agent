/**
 * Orchestrator run loop (Req 1.2, 2.1, 2.3, 2.6, 13.2).
 *
 * The orchestrator is deliberately thin: it knows nothing about qualification
 * frameworks, HTML, or scoring rubrics. This module implements the *run loop*
 * skeleton (task 4.1):
 *
 *  1. Mint a sortable, collision-free `runId` (`run_${ULID}`) — Req 2.6.
 *  2. Resolve the lead as `rawEmail ?? FIXED_LEAD` and normalize it — Req 1.2.
 *  3. Iterate the literal `STAGES` array in fixed order 1→6 — Req 2.1.
 *  4. For each stage, build a `StageContext` whose `upstream` object supplies
 *     EXACTLY the outputs named in that stage's declared `dependsOn` — Req 2.3.
 *     The dependency graph is data (the `dependsOn` array), not control flow.
 *  5. Return a well-formed `RunArtifact`.
 *
 * The following are intentionally left as clearly-marked seams for the tasks
 * that refine this loop; the code here is structured so those tasks slot in
 * without reshaping the loop:
 *
 *  - Task 4.2 (done) — contract validation with bounded retry. Each stage is
 *    invoked up to three times; its output is validated against the stage's
 *    Zod schema and, on failure, the stage is re-invoked with the validation
 *    error in `validationFeedback`. The final attempt is served by the
 *    configured fallback model (via a `useFallbackModel`-forcing `ctx.llm`
 *    proxy) without extending the budget.
 *  - Task 4.3 (done) — per-stage failure handling and the full run-status
 *    matrix. Building on 4.2's retry loop (which degrades an exhausted stage to
 *    `failed` with `"unknown"` output and continues), this adds: the complete
 *    run-status matrix via `computeRunStatus` — `failed` when the pre-stage
 *    `validateEnv` guard throws (no stage runs; all six records stay
 *    `pending`/unknown), `partial` when any stage degraded, else `complete`;
 *    and the placeholder-rejection rule via `degradedOutput`, the single
 *    chokepoint that guarantees ONLY the literal `"unknown"` is ever
 *    substituted (Req 17.6). The `validateEnv` hook now runs the real
 *    required-env check (task 4.4); the `envValidationFailed` path it feeds is
 *    unchanged.
 *  - Task 4.4 (done) — monotonic event sequencing, SSE/artifact fan-out,
 *    `redactSecrets` over every event, and run-start env validation. Every
 *    lifecycle event flows through a single `emit` chokepoint that assigns the
 *    monotonic `seq` and runs `redactStageEvent` before fan-out; the whole
 *    artifact is redacted once more before it is returned (Req 14.5). The real
 *    required-env check (`getConfig()`) runs as the first action; a missing or
 *    invalid required variable emits a `validation_error` naming the variable
 *    (name only) and short-circuits the run to `failed` (Req 14.4).
 *  - Task 5.1/5.2 (done) — provenance enforcement and the unknown-field report.
 *    After a stage succeeds, stages 2/4/5 have their cited URLs cross-checked
 *    against this run's fetch ledger (`applyStageProvenance`), and after all
 *    stages run `buildUnknownFieldReport` populates `unknownFieldReport`.
 *  - Task 20.1 (done) — the literal `STAGES` array (`DEFAULT_STAGES`) is wired
 *    to the six concrete stage modules in fixed 1→6 order, and the redacted
 *    artifact is persisted best-effort via the injectable run store on a
 *    `complete`/`partial` run. The array and store stay injectable via
 *    `options.deps` for testing.
 */

import { randomBytes } from "node:crypto";

import type { ZodType } from "zod";

import type {
  EmailSequence,
  GtmRecommendation,
  HandoffSummary,
  IsoTimestamp,
  LeadProfile,
  LlmProvider,
  MatchResult,
  Maybe,
  QualificationResult,
  RawEmailRecord,
  ResearchReport,
  ResearchToolbelt,
  RunArtifact,
  RunStatus,
  ScoredCaseStudy,
  Stage,
  StageContext,
  StageEvent,
  StageNumber,
  StageRecord,
} from "./contracts";
import { UNKNOWN, type Unknown } from "./contracts";
import { FIXED_LEAD } from "./fixed-lead";
import { normalizeLead } from "./lead-normalizer";
import {
  applyProvenanceFilter,
  verifyCaseStudyProvenance,
  verifyPartnerEvidenceProvenance,
  type IsLedgered,
} from "./provenance";
import { collectSecretsFromEnv, redactArtifact, redactStageEvent } from "./redact";
import { buildUnknownFieldReport } from "./unknown-report";

import { stage1Qualifier } from "./stages/stage-1-qualifier";
import { stage2Researcher } from "./stages/stage-2-researcher";
import { stage3Responder } from "./stages/stage-3-responder";
import { stage4Matcher } from "./stages/stage-4-matcher";
import { stage5GtmAdvisor } from "./stages/stage-5-gtm-advisor";
import { stage6HandoffGenerator } from "./stages/stage-6-handoff-generator";

import { EnvValidationError, getConfig } from "@/lib/config/env";
import { createFetchLedger, type FetchLedger } from "@/research/fetch-ledger";
import { createResearchToolbelt, type ToolbeltStageInfo } from "@/research/toolbelt";
import { createLlmProvider } from "@/providers/llm";
import { createSearchProvider } from "@/providers/search";
import { createLlmThrottle } from "@/providers/llm/throttle";
import { createRunStore, type RunStore } from "@/store/run-store";

// ---------------------------------------------------------------------------
// Options and injectable dependencies
// ---------------------------------------------------------------------------

/** The subset of `StageEvent` a caller emits; the loop fills seq/id/runId/timestamp. */
type EmittableEvent = Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">;

/**
 * Injectable seams. Every field is optional and defaults to the production
 * wiring. Tests and the incremental-wiring tasks (4.2–4.4, 20) override these
 * to run the loop without touching `process.env` or the live providers.
 */
export interface OrchestratorDeps {
  /** The literal, ordered stage array (1→6). Defaults to {@link DEFAULT_STAGES}. */
  stages: readonly Stage<unknown>[];
  /** The LLM provider shared by every stage. Defaults to the env-selected adapter. */
  llm: LlmProvider;
  /** The per-run web-egress toolbelt. Defaults to the real toolbelt bound to `ledger`. */
  toolbelt: ResearchToolbelt;
  /** Provenance ledger factory. Defaults to {@link createFetchLedger}. */
  createLedger: (runId: string) => FetchLedger;
  /** Name-only provider config for the artifact. Defaults to the env-derived config. */
  providerConfig: RunArtifact["providerConfig"];
  /** Injected clock. Defaults to `() => new Date()`. */
  now: () => Date;
  /** Injected `runId` body generator. Defaults to a monotonic ULID. */
  generateUlid: () => string;
  /**
   * Pre-stage environment-validation hook (Req 14.4, 17.6) — the seam task 4.4
   * fills with the full required-env check. It runs as a guard BEFORE any stage
   * is invoked; if it THROWS, the run short-circuits to status `failed` with all
   * six stage records left `pending`/`"unknown"` and no stage runs. It defaults
   * to a no-op so the loop is unaffected until 4.4 wires the real check (plus
   * the `validation_error` event naming the missing variable, and redaction).
   */
  validateEnv: () => void;
  /**
   * Persistence backend for the finished artifact (Req 16.1). Defaults to the
   * env-selected {@link createRunStore}. It is constructed lazily and used only
   * when the run actually executed stages and finished `complete`/`partial`, so
   * tests that inject other deps never touch the real store. Persistence is
   * best-effort: a `put` failure is caught and surfaced as an event, never
   * crashing the run.
   */
  runStore: RunStore;
}

export interface OrchestratorOptions {
  /** Absent → the {@link FIXED_LEAD} is used (Req 1.2). */
  rawEmail?: RawEmailRecord;
  /** SSE sink; every emitted event is also appended to the artifact (Req 11.6). */
  onEvent: (event: StageEvent) => void;
  /** Injectable seams for testing and incremental wiring. */
  deps?: Partial<OrchestratorDeps>;
}

// ---------------------------------------------------------------------------
// Stage metadata and dependency-graph plumbing
// ---------------------------------------------------------------------------

/** The upstream slots a stage may declare a dependency on. */
type UpstreamKey = keyof StageContext["upstream"];

/**
 * The literal, in-order stage array (Req 2.1) — the auditable 1→6 pipeline. Each
 * entry is a concrete stage entry module; the loop iterates this array as data,
 * never branching on stage identity. The array stays injectable via
 * `options.deps.stages` so tests can substitute stubs, but production always
 * runs these six real stages in this fixed order.
 */
export const DEFAULT_STAGES: readonly Stage<unknown>[] = [
  stage1Qualifier as Stage<unknown>,
  stage2Researcher as Stage<unknown>,
  stage3Responder as Stage<unknown>,
  stage4Matcher as Stage<unknown>,
  stage5GtmAdvisor as Stage<unknown>,
  stage6HandoffGenerator as Stage<unknown>,
];

/** Static per-stage metadata so all six artifact records are well-formed even if a stage never runs. */
const STAGE_METADATA: Record<StageNumber, { stageName: string; sourceFile: string }> = {
  1: { stageName: "Qualifier", sourceFile: "src/agent/stages/stage-1-qualifier.ts" },
  2: { stageName: "Researcher", sourceFile: "src/agent/stages/stage-2-researcher.ts" },
  3: { stageName: "Responder", sourceFile: "src/agent/stages/stage-3-responder.ts" },
  4: { stageName: "Matcher", sourceFile: "src/agent/stages/stage-4-matcher.ts" },
  5: { stageName: "GTM Advisor", sourceFile: "src/agent/stages/stage-5-gtm-advisor.ts" },
  6: { stageName: "Handoff", sourceFile: "src/agent/stages/stage-6-handoff-generator.ts" },
};

/**
 * Which upstream slot each stage's output fills. Stage 6 (the handoff summary)
 * produces no output that any later stage consumes, so it maps to `undefined`.
 */
const PRODUCES: Record<StageNumber, UpstreamKey | undefined> = {
  1: "qualification",
  2: "research",
  3: "emails",
  4: "match",
  5: "gtm",
  6: undefined,
};

/**
 * The per-stage invocation budget (Req 17.4). A stage is invoked at most this
 * many times in total: the initial attempt plus two feedback-driven retries.
 * The final attempt may be served by the configured fallback model, which
 * changes *which* model serves that attempt but never adds an invocation — so
 * Property 36 ("stage retries are bounded at three attempts, fallback model
 * included") holds unchanged.
 */
const MAX_STAGE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

/**
 * Runs the six-stage pipeline for one lead and returns the resulting artifact.
 *
 * @see OrchestratorOptions
 */
export async function runPipeline(options: OrchestratorOptions): Promise<RunArtifact> {
  const now = options.deps?.now ?? (() => new Date());
  const generateUlid = options.deps?.generateUlid ?? defaultUlidFactory();

  // 1. Run identity — sortable (ULID time prefix) and collision-free (Req 2.6).
  const runId = `run_${generateUlid()}`;
  const startedAt: IsoTimestamp = now().toISOString();

  // 2. Lead resolution + normalization (Req 1.2–1.4). Missing fields → "unknown".
  const rawEmail = options.rawEmail ?? FIXED_LEAD;
  const leadProfile: LeadProfile = normalizeLead(rawEmail, () => now().toISOString());

  // The configured provider secrets for this process, resolved once so the
  // per-event redaction pass exact-matches them wherever they appear. Never
  // throws: an invalid/missing env yields `[]` and the pattern pass still runs
  // (the env-validation failure path below relies on that).
  const knownSecrets = collectSecretsFromEnv();

  // Event chokepoint. Fans every event out to the SSE sink and the artifact
  // array through one place, and is the sole seam where monotonic `seq` is
  // assigned and `redactSecrets` runs (Req 11.6, 14.5). `seq` is monotonic per
  // run; every event is redacted BEFORE it reaches either sink, so no secret is
  // ever streamed to the client or stored in the artifact's event array.
  const events: StageEvent[] = [];
  let seq = 0;
  const emit = (partial: EmittableEvent): void => {
    const current = seq;
    seq += 1;
    const event: StageEvent = redactStageEvent(
      {
        ...partial,
        seq: current,
        eventId: `evt_${runId}_${current}`,
        runId,
        timestamp: now().toISOString(),
      },
      knownSecrets,
    );
    events.push(event);
    options.onEvent(event);
  };

  // Per-run provenance ledger; shared by the toolbelt across all stages.
  const ledger = (options.deps?.createLedger ?? createFetchLedger)(runId);

  // The stage currently executing, reflected into toolbelt ledger entries.
  let currentStage: ToolbeltStageInfo = { stage: 1, stageName: STAGE_METADATA[1].stageName };

  // Providers are resolved lazily so a run with no stages (or an injected LLM /
  // toolbelt / providerConfig) never constructs a live adapter or reads env it
  // does not need.
  let llm = options.deps?.llm ?? null;
  const getLlm = (): LlmProvider => {
    if (llm === null) llm = createDefaultLlm();
    return llm;
  };

  let toolbelt = options.deps?.toolbelt ?? null;
  const getToolbelt = (): ResearchToolbelt => {
    if (toolbelt === null) {
      toolbelt = createResearchToolbelt({
        searchProvider: createSearchProvider(),
        ledger,
        emit,
        stageInfo: () => currentStage,
      });
    }
    return toolbelt;
  };

  const providerConfig =
    options.deps?.providerConfig ?? buildProviderConfig(getLlm());

  const stages = options.deps?.stages ?? DEFAULT_STAGES;

  // Persistence backend, resolved lazily so a run that never reaches a
  // persistable status (or an injected store) never constructs the real store
  // and never reads the env it needs.
  let runStore = options.deps?.runStore ?? null;
  const getRunStore = (): RunStore => {
    if (runStore === null) runStore = createRunStore();
    return runStore;
  };

  // The provenance gate reads the SAME per-run ledger the toolbelt appends to,
  // so a URL only passes if it was actually fetched-with-success this run.
  const isLedgered: IsLedgered = (url: string) => ledger.isLedgered(url);

  // Pre-populate all six stage records so the artifact is always well-formed,
  // even for stages that never run in this loop.
  const records: StageRecord<unknown>[] = ([1, 2, 3, 4, 5, 6] as StageNumber[]).map(
    (n) => initialRecord(n),
  );

  // Accumulator of completed upstream outputs, keyed by the slot each fills.
  const upstreamOutputs: StageContext["upstream"] = {};

  emit({
    stage: null,
    stageName: null,
    type: "run_started",
    message: `Run ${runId} started for ${describeLead(leadProfile)}`,
    inputSummary: describeLead(leadProfile),
  });

  let anyFailed = false;

  // Pre-stage environment validation (Req 14.4) — the first thing the run does
  // before any stage is invoked. The default hook runs the full required-env
  // check via `getConfig()`, which throws an `EnvValidationError` naming the
  // offending variable (name only, never its value) on the first missing or
  // invalid required var. It stays injectable so tests can force the pass or
  // failure path without touching `process.env`.
  //
  // On failure the run short-circuits to status `failed`: a `validation_error`
  // event names the missing variable, the stage loop below never runs, and all
  // six stage records stay `pending` with `"unknown"` output.
  const validateEnv = options.deps?.validateEnv ?? defaultValidateEnv;
  let envValidationFailed = false;
  try {
    validateEnv();
  } catch (error) {
    envValidationFailed = true;
    const variableName =
      error instanceof EnvValidationError ? error.variableName : undefined;
    emit({
      stage: null,
      stageName: null,
      type: "validation_error",
      message: variableName
        ? `Environment validation failed: required variable ${variableName} is missing or invalid. The run cannot proceed.`
        : `Environment validation failed; the run cannot proceed.`,
    });
  }

  // 3. Iterate the fixed STAGES array in order (Req 2.1). Skipped entirely when
  //    pre-stage env validation failed, leaving every record `pending`/unknown.
  for (const stage of envValidationFailed ? [] : stages) {
    const record = records[stage.stage - 1];
    if (record === undefined) continue; // defensive: only stages 1..6 are valid
    // Adopt the stage's self-declared identity (Req 13.1).
    record.stageName = stage.stageName;
    record.sourceFile = stage.sourceFile;
    currentStage = { stage: stage.stage, stageName: stage.stageName };

    // 4. Build the StageContext, supplying EXACTLY the declared dependencies
    //    (Req 2.3). Only the `dependsOn` slots are copied into `upstream`; a
    //    dependency the upstream stage failed to produce is passed as "unknown".
    const upstream: StageContext["upstream"] = {};
    for (const dep of stage.dependsOn) {
      assignUpstream(upstream, dep, upstreamOutputs[dep] ?? UNKNOWN);
    }

    const startedAtStage = now();
    record.status = "running";
    record.startedAt = startedAtStage.toISOString();
    record.attempts = 0;

    emit({
      stage: stage.stage,
      stageName: stage.stageName,
      type: "stage_started",
      message: `Stage ${stage.stage} (${stage.stageName}) started`,
      inputSummary: summarizeDependencies(stage.dependsOn, upstream),
    });

    // 5. Contract validation with bounded retry (Req 17.4). Run the stage,
    //    validate its output against the stage's declared Zod schema, and on a
    //    validation failure (or a thrown error) re-invoke with the validation
    //    error threaded back through `validationFeedback`. At most
    //    MAX_STAGE_ATTEMPTS (3) invocations. The FINAL attempt switches to the
    //    configured fallback model by wrapping `ctx.llm` in a proxy that forces
    //    `useFallbackModel` — the stage code is unchanged, and the fallback
    //    stays inside the budget rather than extending it (Property 36).
    let succeeded = false;
    let acceptedOutput: unknown = UNKNOWN;
    let lastFailureReason: string = UNKNOWN;
    let validationFeedback: string | undefined;

    for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
      record.attempts = attempt;

      // Only the final attempt switches models, and only when a fallback is
      // actually configured (`fallbackModel !== "unknown"`); otherwise the
      // wrap would be a no-op and we keep the primary provider unchanged.
      const isFinalAttempt = attempt === MAX_STAGE_ATTEMPTS;
      const baseLlm = getLlm();
      const useFallback = isFinalAttempt && baseLlm.fallbackModel !== UNKNOWN;
      const attemptLlm = useFallback
        ? withForcedFallbackModel(baseLlm, emit, stage, attempt)
        : baseLlm;

      const ctx: StageContext = {
        runId,
        leadProfile,
        toolbelt: getToolbelt(),
        llm: attemptLlm,
        emit,
        attempt,
        ...(validationFeedback === undefined ? {} : { validationFeedback }),
        upstream,
      };

      try {
        const output = await stage.run(ctx);

        // Enforce the stage contract at the orchestrator boundary (Req 17.4):
        // even a stage that resolved may have produced a shape its schema
        // rejects. A rejection is a retryable validation failure, not a throw.
        const parsed = stage.schema.safeParse(output);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          lastFailureReason = `Output failed schema validation: ${issues}`;
          validationFeedback = `Attempt ${attempt} ${lastFailureReason}`;
          emit({
            stage: stage.stage,
            stageName: stage.stageName,
            type: "validation_error",
            message: `Stage ${stage.stage} (${stage.stageName}) attempt ${attempt} failed validation: ${issues}`,
          });
          continue;
        }

        acceptedOutput = parsed.data;
        succeeded = true;
        break;
      } catch (error) {
        // A thrown error (including a typed LlmValidationError from the
        // provider boundary) is treated identically to a schema rejection:
        // feed it back and retry until the budget is spent.
        lastFailureReason = error instanceof Error ? error.message : String(error);
        validationFeedback = `Attempt ${attempt} failed: ${lastFailureReason}`;
        emit({
          stage: stage.stage,
          stageName: stage.stageName,
          type: "validation_error",
          message: `Stage ${stage.stage} (${stage.stageName}) attempt ${attempt} failed: ${lastFailureReason}`,
        });
        continue;
      }
    }

    const completedAtStage = now();
    const durationMs = completedAtStage.getTime() - startedAtStage.getTime();
    record.completedAt = completedAtStage.toISOString();
    record.durationMs = durationMs;

    if (succeeded) {
      // Provenance enforcement (Req 5.1–5.3, 5.6) — the orchestrator-side
      // anti-fabrication gate. Stages 2/4/5 emit cited URLs; here every cited
      // URL is cross-checked against this run's fetch ledger before the output
      // is trusted. Unledgered claims/figures/evidence collapse to the
      // Unknown_Marker. The filtered output is what both the artifact record
      // AND the downstream upstream slot see, so no unverified claim can leak
      // past this point. Stages 1/3/6 have no cited-URL surface and pass
      // through unchanged.
      const finalOutput = applyStageProvenance(stage.stage, acceptedOutput, isLedgered, emit);

      record.status = "complete";
      record.output = finalOutput;
      record.failureReason = UNKNOWN;

      // Publish this stage's (provenance-filtered) output to the upstream slot
      // it fills (Req 2.3).
      const producedKey = PRODUCES[stage.stage];
      if (producedKey !== undefined) {
        assignUpstream(upstreamOutputs, producedKey, finalOutput);
      }

      emit({
        stage: stage.stage,
        stageName: stage.stageName,
        type: "stage_completed",
        message: `Stage ${stage.stage} (${stage.stageName}) completed`,
        stageStatus: "complete",
        output: finalOutput,
        durationMs,
      });
    } else {
      // Retry budget exhausted — mark the stage `failed` and substitute the
      // Unknown_Marker for its output, then continue downstream with that same
      // unknown value in the slot this stage would have filled (Req 2.5). Every
      // substitution is routed through `degradedOutput()` so the sole legal
      // substitute is the literal "unknown": no placeholder, sample, or
      // illustrative value can ever be swapped in here (Req 17.6).
      anyFailed = true;
      record.status = "failed";
      record.output = degradedOutput();
      record.failureReason = lastFailureReason;

      const producedKey = PRODUCES[stage.stage];
      if (producedKey !== undefined) {
        assignUpstream(upstreamOutputs, producedKey, degradedOutput());
      }

      emit({
        stage: stage.stage,
        stageName: stage.stageName,
        type: "stage_failed",
        message: `Stage ${stage.stage} (${stage.stageName}) failed after ${record.attempts} attempts: ${lastFailureReason}`,
        stageStatus: "failed",
      });
    }
  }

  // 5. Assemble the artifact. The full run-status matrix (Req 2.4, 2.5, 14.4):
  //    - `failed`   → pre-stage env validation failed; no stage ran.
  //    - `partial`  → at least one stage failed and degraded to "unknown".
  //    - `complete` → every stage that ran succeeded.
  //    The order matters: a pre-stage failure dominates, because a run that
  //    never began its stages is not merely `partial`.
  const status: RunStatus = computeRunStatus({ envValidationFailed, anyFailed });
  const completedAt: IsoTimestamp = now().toISOString();

  const stageRecords = {
    stage1: records[0] as StageRecord<QualificationResult>,
    stage2: records[1] as StageRecord<ResearchReport>,
    stage3: records[2] as StageRecord<EmailSequence>,
    stage4: records[3] as StageRecord<MatchResult>,
    stage5: records[4] as StageRecord<GtmRecommendation>,
    stage6: records[5] as StageRecord<HandoffSummary>,
  };

  // Unknown-field report (Req 5.7, 17.5): after every stage has run, deep-walk
  // the six stage outputs and record each field equal to the Unknown_Marker.
  // One `unknown_substitution` event is emitted per reported field, so the
  // Limitations panel and the trace agree. Runs before `run_completed` so those
  // events precede the terminal event in the stream.
  const unknownFieldReport = buildUnknownFieldReport(stageRecords, emit);

  emit({
    stage: null,
    stageName: null,
    type: "run_completed",
    message: `Run ${runId} finished with status ${status}`,
    stageStatus: undefined,
  });

  const artifact: RunArtifact = {
    schemaVersion: 1,
    runId,
    status,
    startedAt,
    completedAt,
    leadProfile,
    providerConfig,
    stages: stageRecords,
    events,
    fetchLedger: ledger.getLedger().slice(),
    unknownFieldReport,
  };

  // Final defense-in-depth pass (Req 14.5): redact the whole artifact before it
  // is returned/persisted, so no secret survives serialization even if one
  // reached a stage output, ledger entry, or lead field. The event array was
  // already redacted per-event at `emit`, and redaction is idempotent.
  const redacted = redactArtifact(artifact, knownSecrets);

  // Persistence (Req 16.1): store the redacted artifact under its `runId` when
  // the run actually executed stages and finished `complete` or `partial`. A
  // `failed` run (pre-stage env validation failed, no stage ran) is NOT
  // persisted. Persistence is best-effort and injectable: a store failure is
  // caught and surfaced as a `reasoning` event rather than crashing the run.
  if (status === "complete" || status === "partial") {
    try {
      await getRunStore().put(redacted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emit({
        stage: null,
        stageName: null,
        type: "reasoning",
        message: `Run artifact ${runId} could not be persisted: ${reason}. The run itself succeeded.`,
      });
    }
  }

  return redacted;
}

/**
 * Applies the relevant provenance gate to a freshly-accepted stage output
 * (Req 5.1–5.3, 5.6). Stages 2/4/5 carry cited URLs and are cross-checked
 * against the run's fetch ledger; all other stages pass through unchanged. The
 * returned value replaces the stage's output everywhere (the artifact record
 * and the downstream upstream slot), so an unledgered citation cannot survive.
 */
function applyStageProvenance(
  stageNumber: StageNumber,
  output: unknown,
  isLedgered: IsLedgered,
  emit: (partial: EmittableEvent) => void,
): unknown {
  switch (stageNumber) {
    case 2:
      return applyProvenanceFilter(output as ResearchReport, isLedgered, emit);
    case 4: {
      const match = output as MatchResult;
      const verifyScored = (scored: ScoredCaseStudy): ScoredCaseStudy => ({
        ...scored,
        record: verifyCaseStudyProvenance(scored.record, isLedgered, emit),
      });
      return {
        ...match,
        rankedCorpus: match.rankedCorpus.map(verifyScored),
        winner: match.winner === UNKNOWN ? match.winner : verifyScored(match.winner),
        runnerUp: match.runnerUp === UNKNOWN ? match.runnerUp : verifyScored(match.runnerUp),
      } satisfies MatchResult;
    }
    case 5:
      return verifyPartnerEvidenceProvenance(output as GtmRecommendation, isLedgered, emit);
    default:
      return output;
  }
}

/**
 * The default pre-stage env-validation hook (Req 14.4). Runs the full
 * required-env check by resolving the memoized {@link getConfig}, which throws
 * an {@link EnvValidationError} naming the first missing/invalid required
 * variable. Kept as a named function so the run loop reads cleanly and tests can
 * override it via `deps.validateEnv`.
 */
function defaultValidateEnv(): void {
  getConfig();
}

// ---------------------------------------------------------------------------
// Default provider wiring (only constructed when not injected)
// ---------------------------------------------------------------------------

/** Constructs the env-selected LLM provider behind the shared RPM throttle. */
function createDefaultLlm(): LlmProvider {
  const config = getConfig();
  const throttle = createLlmThrottle({
    maxRpm: config.llmMaxRpm,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    // Task 4.4 maps throttle waits into `llm_call` StageEvents; a no-op keeps
    // the run-loop seam clean until then.
    emit: () => {},
  });
  return createLlmProvider({ throttle });
}

/** Builds the name-only provider config recorded in the artifact (Req 14.5). */
function buildProviderConfig(llm: LlmProvider): RunArtifact["providerConfig"] {
  const config = getConfig();
  return {
    llmProvider: llm.name,
    llmModel: llm.model,
    llmFallbackModel: llm.fallbackModel,
    llmMaxRpm: config.llmMaxRpm,
    searchProvider: config.searchProvider,
    runStoreBackend: config.runStoreBackend,
    runStoreDurable: config.runStoreDurable,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an {@link LlmProvider} so every `completeJson` call it serves is forced
 * onto the configured fallback model (Req 17.4). The orchestrator applies this
 * ONLY on a stage's final attempt and ONLY when a fallback is configured, which
 * is what keeps the fallback inside the three-attempt budget instead of
 * extending it (Property 36). The stage code is unchanged: it still calls
 * `ctx.llm.completeJson(...)` normally; the proxy sets `useFallbackModel` for
 * it.
 *
 * Each proxied call emits an `llm_call` StageEvent with `fallbackModelUsed:
 * true` and the model that actually served the call, so the trace shows which
 * model produced the (accepted or rejected) output. The event is emitted even
 * when the underlying call throws, so a fallback attempt that also fails
 * validation is still visible in the trace before the stage degrades.
 */
function withForcedFallbackModel(
  llm: LlmProvider,
  emit: (partial: EmittableEvent) => void,
  stage: Stage<unknown>,
  attempt: number,
): LlmProvider {
  // Caller guarantees `fallbackModel !== UNKNOWN`; fall back to the primary
  // model name only defensively so the emitted trace is never `"unknown"`.
  const servingModel = llm.fallbackModel === UNKNOWN ? llm.model : llm.fallbackModel;

  return {
    name: llm.name,
    model: llm.model,
    fallbackModel: llm.fallbackModel,

    async completeJson<T>(args: {
      purpose: string;
      systemPrompt: string;
      userPrompt: string;
      schema: ZodType<T>;
      maxOutputTokens?: number;
      temperature?: number;
      useFallbackModel?: boolean;
    }) {
      let modelUsed: string = servingModel;
      let promptTokens: Maybe<number> = UNKNOWN;
      let completionTokens: Maybe<number> = UNKNOWN;
      try {
        const result = await llm.completeJson<T>({ ...args, useFallbackModel: true });
        modelUsed = result.modelUsed;
        promptTokens = result.usage.promptTokens;
        completionTokens = result.usage.completionTokens;
        return result;
      } finally {
        emit({
          stage: stage.stage,
          stageName: stage.stageName,
          type: "llm_call",
          message: `LLM call "${args.purpose}" served by fallback model ${modelUsed} (attempt ${attempt}).`,
          llmCall: {
            provider: llm.name,
            model: modelUsed,
            purpose: args.purpose,
            promptTokens,
            completionTokens,
            attempt,
            fallbackModelUsed: true,
          },
        });
      }
    },
  };
}

/**
 * The run-status matrix (Req 2.4, 2.5, 14.4). A pre-stage env-validation
 * failure dominates and yields `failed`; otherwise any degraded stage makes the
 * run `partial`; a clean run is `complete`. Factored out so the matrix is a
 * single auditable expression rather than nested ternaries at the call site.
 */
function computeRunStatus(flags: {
  envValidationFailed: boolean;
  anyFailed: boolean;
}): RunStatus {
  if (flags.envValidationFailed) return "failed";
  if (flags.anyFailed) return "partial";
  return "complete";
}

/**
 * Returns the ONE value the orchestrator is permitted to substitute for a
 * failed or missing stage output: the literal Unknown_Marker (Req 17.5, 17.6).
 * Requirement 15.6 forbids any placeholder, sample, or illustrative factual
 * value from entering a stage output when retrieval fails, so the degradation
 * path never invents a stand-in — it calls this. The guard asserts the marker
 * is exactly `"unknown"`, so the substitution rule cannot be silently loosened
 * to a "TBD"/"N/A"/example value by a later edit without tripping here.
 */
function degradedOutput(): Unknown {
  if ((UNKNOWN as string) !== "unknown") {
    throw new Error(
      `Placeholder-substitution invariant violated: only "unknown" may be substituted, got ${String(UNKNOWN)}`,
    );
  }
  return UNKNOWN;
}

function initialRecord(stage: StageNumber): StageRecord<unknown> {
  const meta = STAGE_METADATA[stage];
  return {
    stage,
    stageName: meta.stageName,
    sourceFile: meta.sourceFile,
    status: "pending",
    attempts: 0,
    startedAt: UNKNOWN,
    completedAt: UNKNOWN,
    durationMs: UNKNOWN,
    output: UNKNOWN,
    failureReason: UNKNOWN,
  };
}

/**
 * Writes a stage output into the upstream accumulator under its slot. Typed as
 * a narrow switch so each slot receives only its own output type (or "unknown").
 */
function assignUpstream(
  acc: StageContext["upstream"],
  key: UpstreamKey,
  value: unknown,
): void {
  switch (key) {
    case "qualification":
      acc.qualification = value as StageContext["upstream"]["qualification"];
      break;
    case "research":
      acc.research = value as StageContext["upstream"]["research"];
      break;
    case "emails":
      acc.emails = value as StageContext["upstream"]["emails"];
      break;
    case "match":
      acc.match = value as StageContext["upstream"]["match"];
      break;
    case "gtm":
      acc.gtm = value as StageContext["upstream"]["gtm"];
      break;
  }
}

function describeLead(lead: LeadProfile): string {
  const company = lead.company === UNKNOWN ? "unknown company" : lead.company;
  const sender = lead.senderName === UNKNOWN ? "unknown sender" : lead.senderName;
  return `${sender} @ ${company}`;
}

function summarizeDependencies(
  dependsOn: readonly UpstreamKey[],
  upstream: StageContext["upstream"],
): string {
  if (dependsOn.length === 0) return "leadProfile only";
  const parts = dependsOn.map((dep) => {
    const value = upstream[dep];
    return `${dep}=${value === UNKNOWN || value === undefined ? "unknown" : "present"}`;
  });
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Monotonic ULID (Req 2.6) — sortable time prefix + 80 bits of randomness.
// Implemented inline to avoid a new runtime dependency.
// ---------------------------------------------------------------------------

const ULID_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const ULID_ENCODING_LEN = 32;
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;

function encodeUlidTime(time: number): string {
  let value = time;
  let out = "";
  for (let i = ULID_TIME_LEN - 1; i >= 0; i -= 1) {
    const mod = value % ULID_ENCODING_LEN;
    out = ULID_ENCODING[mod] + out;
    value = (value - mod) / ULID_ENCODING_LEN;
  }
  return out;
}

function encodeUlidRandom(): string {
  // 256 is an exact multiple of 32, so `byte % 32` is a uniform base32 digit.
  const bytes = randomBytes(ULID_RANDOM_LEN);
  let out = "";
  for (let i = 0; i < ULID_RANDOM_LEN; i += 1) {
    out += ULID_ENCODING[(bytes[i] as number) % ULID_ENCODING_LEN];
  }
  return out;
}

/** Increments a base32 string by one, carrying left; overflow regenerates. */
function incrementUlidRandom(random: string): string {
  const chars = random.split("");
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = ULID_ENCODING.indexOf(chars[i] as string);
    if (idx < ULID_ENCODING_LEN - 1) {
      chars[i] = ULID_ENCODING[idx + 1] as string;
      return chars.join("");
    }
    chars[i] = ULID_ENCODING[0] as string;
  }
  return encodeUlidRandom();
}

/**
 * Returns a monotonic ULID generator. Within the same millisecond the random
 * component is incremented rather than regenerated, so ids minted back-to-back
 * remain strictly increasing and therefore lexicographically sortable.
 */
export function defaultUlidFactory(now: () => number = () => Date.now()): () => string {
  let lastTime = -1;
  let lastRandom = "";
  return function ulid(): string {
    const t = now();
    if (t <= lastTime) {
      lastRandom = incrementUlidRandom(lastRandom);
    } else {
      lastTime = t;
      lastRandom = encodeUlidRandom();
    }
    return encodeUlidTime(lastTime) + lastRandom;
  };
}
