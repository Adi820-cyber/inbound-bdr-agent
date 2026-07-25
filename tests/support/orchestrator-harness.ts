/**
 * Shared harness for the orchestrator run-loop property tests (tasks 4.5–4.10).
 *
 * The orchestrator (`src/agent/orchestrator.ts`) is deliberately injectable:
 * `runPipeline({ rawEmail?, onEvent, deps? })` accepts a fully-stubbed
 * `OrchestratorDeps` so the loop can be exercised deterministically WITHOUT any
 * real stage, env read, or network/LLM egress. This module builds the fakes the
 * loop needs:
 *
 *  - {@link fakeStage} — a minimal `Stage<unknown>` whose `run`, `schema`,
 *    `dependsOn`, and `stage` number are all caller-controlled, so a test can
 *    make a stage succeed (schema-valid output), fail-by-throw, or
 *    fail-by-invalid-output on demand.
 *  - {@link makeDeps} — a complete `OrchestratorDeps` wired to the stub LLM,
 *    a no-op toolbelt, a name-only provider config, and a no-op `validateEnv`,
 *    so `getConfig()`/`process.env`/live adapters are never touched.
 *
 * The `PRODUCED_KEY` / `PRODUCER_STAGE` maps mirror the orchestrator's own
 * `PRODUCES` table (stage number → the upstream slot its output fills), so the
 * tests can predict exactly which upstream slot each stage feeds.
 */

import { z } from "zod";
import type { ZodType } from "zod";

import type {
  LlmProvider,
  ResearchToolbelt,
  RunArtifact,
  Stage,
  StageContext,
  StageNumber,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import type { OrchestratorDeps } from "@/agent/orchestrator";

import { createStubLlmProvider } from "./stub-llm";

/** The upstream slot each stage number fills — mirrors the orchestrator's `PRODUCES`. */
export const PRODUCED_KEY: Record<
  StageNumber,
  keyof StageContext["upstream"] | undefined
> = {
  1: "qualification",
  2: "research",
  3: "emails",
  4: "match",
  5: "gtm",
  6: undefined,
};

/** Inverse of {@link PRODUCED_KEY}: which stage number produces a given upstream slot. */
export const PRODUCER_STAGE: Record<
  keyof StageContext["upstream"],
  StageNumber
> = {
  qualification: 1,
  research: 2,
  emails: 3,
  match: 4,
  gtm: 5,
};

/** All upstream slots produced by stages strictly before `stage` (in 1→6 order). */
export function producerKeysBefore(
  stage: StageNumber,
): (keyof StageContext["upstream"])[] {
  const keys: (keyof StageContext["upstream"])[] = [];
  for (let n = 1; n < stage; n += 1) {
    const key = PRODUCED_KEY[n as StageNumber];
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/** A no-op toolbelt: never touches the network, records nothing. */
export function createStubToolbelt(): ResearchToolbelt {
  return {
    async search() {
      return [];
    },
    async fetchPage() {
      return null;
    },
    getLedger() {
      return [];
    },
    isLedgered() {
      return false;
    },
  };
}

/** A name-only provider config for the artifact (never carries a key). */
export function stubProviderConfig(): RunArtifact["providerConfig"] {
  return {
    llmProvider: "openrouter",
    llmModel: "stub-model",
    llmFallbackModel: UNKNOWN,
    llmMaxRpm: 20,
    searchProvider: "tavily",
    runStoreBackend: "json_file",
    runStoreDurable: false,
  };
}

export interface MakeDepsOverrides {
  stages: readonly Stage<unknown>[];
  llm?: LlmProvider;
  toolbelt?: ResearchToolbelt;
  providerConfig?: RunArtifact["providerConfig"];
  validateEnv?: () => void;
}

/**
 * Builds a complete, fully-stubbed {@link OrchestratorDeps}. Every seam that
 * would otherwise read env or reach a provider is stubbed, so `runPipeline`
 * runs purely against the injected stages.
 */
export function makeDeps(overrides: MakeDepsOverrides): Partial<OrchestratorDeps> {
  return {
    stages: overrides.stages,
    llm: overrides.llm ?? createStubLlmProvider(),
    toolbelt: overrides.toolbelt ?? createStubToolbelt(),
    providerConfig: overrides.providerConfig ?? stubProviderConfig(),
    validateEnv: overrides.validateEnv ?? (() => {}),
  };
}

export interface FakeStageOptions {
  stage: StageNumber;
  stageName?: string;
  sourceFile?: string;
  dependsOn?: readonly (keyof StageContext["upstream"])[];
  usesToolbelt?: boolean;
  /** Defaults to `z.any()`, which accepts any produced value. */
  schema?: ZodType;
  run: (ctx: StageContext) => Promise<unknown> | unknown;
}

/** Builds a minimal, fully caller-controlled `Stage<unknown>`. */
export function fakeStage(options: FakeStageOptions): Stage<unknown> {
  const { stage } = options;
  return {
    stage,
    stageName: options.stageName ?? `Stage ${stage}`,
    sourceFile: options.sourceFile ?? `src/agent/stages/stage-${stage}.ts`,
    dependsOn: options.dependsOn ?? [],
    usesToolbelt: options.usesToolbelt ?? false,
    schema: options.schema ?? z.any(),
    run: (ctx) => Promise.resolve(options.run(ctx)),
  };
}

/** The strict per-stage marker schema used by the success/invalid fakes. */
export const markerSchema = z.object({ marker: z.string() });

/** The schema-valid success output for a given stage. */
export function markerOutput(stage: StageNumber): { marker: string } {
  return { marker: `stage-${stage}` };
}

/** Returns the artifact stage record for a given stage number. */
export function recordForStage(artifact: RunArtifact, stage: StageNumber) {
  return artifact.stages[`stage${stage}` as keyof RunArtifact["stages"]];
}
