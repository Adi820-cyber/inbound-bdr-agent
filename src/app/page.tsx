"use client";

import React, { useState } from "react";
import { useRunStream } from "@/hooks/useRunStream";
import { RunStatusBar } from "@/components/RunStatusBar";
import { RunTrigger } from "@/components/RunTrigger";
import { LeadEditor } from "@/components/LeadEditor";
import { StagePanel } from "@/components/StagePanel";
import { LimitationsPanel } from "@/components/LimitationsPanel";
import { StreamInterruptedNotice } from "@/components/StreamInterruptedNotice";

import { Stage1View } from "@/components/stage-views/Stage1View";
import { Stage2View } from "@/components/stage-views/Stage2View";
import { Stage3View } from "@/components/stage-views/Stage3View";
import { Stage4View } from "@/components/stage-views/Stage4View";
import { Stage5View } from "@/components/stage-views/Stage5View";
import { Stage6View } from "@/components/stage-views/Stage6View";

import type { RawEmailRecord, ResearchReport } from "@/agent/contracts";
import { FIXED_LEAD } from "@/agent/fixed-lead";

export default function Home() {
  const { state, triggerRun, reloadRun, retryRun } = useRunStream();
  const [leadRecord, setLeadRecord] = useState<RawEmailRecord>(FIXED_LEAD);

  const handleStartPipeline = () => {
    triggerRun(leadRecord);
  };

  const handleReloadRun = () => {
    if (state.runId) {
      reloadRun(state.runId);
    }
  };

  const isRunning = state.runStatus === "running";

  // Derive verified claim count with proper Maybe narrowing
  const stage2Output = state.stages[2].output;
  let verifiedClaimCount = 0;
  if (stage2Output && typeof stage2Output === "object" && stage2Output !== null) {
    const report = stage2Output as ResearchReport;
    if (typeof report.verifiedClaimCount === "number") {
      verifiedClaimCount = report.verifiedClaimCount;
    }
  }

  // Limitations from artifact or empty
  const limitations = state.artifact?.unknownFieldReport ?? [];

  // Find last active stage for interrupted notice
  const lastActiveStageSeen = ([6, 5, 4, 3, 2, 1] as const).find(
    (n) => state.stages[n].status !== "pending"
  ) ?? 0;

  return (
    <div suppressHydrationWarning className="min-h-screen bg-[#0b0d10] text-[#e6e9ed] font-sans antialiased p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-[#262c33] pb-6">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white flex items-center gap-2">
              <span>FlytBase Inbound BDR Agent</span>
              <span className="text-xs px-2 py-0.5 rounded font-mono bg-blue-950 text-blue-400 border border-blue-800">
                v1.0
              </span>
            </h1>
            <p className="text-xs text-[#97a1ad] mt-1">
              Autonomous six-stage pipeline: Qualification → Research → Email Sequence → Case Match → GTM Motion → AE Handoff.
            </p>
          </div>

          <RunTrigger
            onTrigger={handleStartPipeline}
            isRunning={isRunning}
            leadRecord={leadRecord}
          />
        </header>

        <LeadEditor onSaveLead={setLeadRecord} currentLead={leadRecord} />

        <RunStatusBar
          status={state.runStatus}
          runId={state.runId}
          elapsedMs={state.elapsedMs}
          verifiedClaimCount={verifiedClaimCount}
          isDurable={state.artifact?.providerConfig?.runStoreDurable ?? false}
        />

        {state.error && (
          <div className="bg-red-950/40 border border-red-800/80 rounded-lg p-3 mb-4 text-xs text-red-300">
            <span className="font-bold text-red-400">Error: </span>{state.error}
          </div>
        )}

        {state.isInterrupted && (
          <StreamInterruptedNotice
            elapsedMs={state.elapsedMs}
            lastStageSeen={lastActiveStageSeen}
            runId={state.runId}
            onRetry={retryRun}
            onReload={handleReloadRun}
          />
        )}

        <main className="space-y-4">
          <StagePanel
            stageNumber={1}
            title="Qualification & Fit Assessment"
            sourceFile="src/agent/stages/stage-1-qualifier.ts"
            status={state.stages[1].status}
            durationMs={state.stages[1].durationMs}
            events={state.stages[1].events}
          >
            <Stage1View output={state.stages[1].output} />
          </StagePanel>

          <StagePanel
            stageNumber={2}
            title="Account Research & Provenance"
            sourceFile="src/agent/stages/stage-2-researcher.ts"
            status={state.stages[2].status}
            durationMs={state.stages[2].durationMs}
            events={state.stages[2].events}
          >
            <Stage2View output={state.stages[2].output} />
          </StagePanel>

          <StagePanel
            stageNumber={3}
            title="Adaptive Response Sequence"
            sourceFile="src/agent/stages/stage-3-responder.ts"
            status={state.stages[3].status}
            durationMs={state.stages[3].durationMs}
            events={state.stages[3].events}
          >
            <Stage3View output={state.stages[3].output} />
          </StagePanel>

          <StagePanel
            stageNumber={4}
            title="Attribute-Driven Case Study Match"
            sourceFile="src/agent/stages/stage-4-matcher.ts"
            status={state.stages[4].status}
            durationMs={state.stages[4].durationMs}
            events={state.stages[4].events}
          >
            <Stage4View output={state.stages[4].output} />
          </StagePanel>

          <StagePanel
            stageNumber={5}
            title="GTM Motion & Partner Strategy"
            sourceFile="src/agent/stages/stage-5-gtm-advisor.ts"
            status={state.stages[5].status}
            durationMs={state.stages[5].durationMs}
            events={state.stages[5].events}
          >
            <Stage5View output={state.stages[5].output} />
          </StagePanel>

          <StagePanel
            stageNumber={6}
            title="AE Handoff Summary"
            sourceFile="src/agent/stages/stage-6-handoff-generator.ts"
            status={state.stages[6].status}
            durationMs={state.stages[6].durationMs}
            events={state.stages[6].events}
          >
            <Stage6View output={state.stages[6].output} />
          </StagePanel>

          {(state.runStatus === "complete" || state.runStatus === "partial") && limitations.length > 0 && (
            <LimitationsPanel items={limitations} />
          )}
        </main>

        {/* Run permalink footer */}
        {state.runId && (state.runStatus === "complete" || state.runStatus === "partial") && (
          <footer className="mt-8 pt-4 border-t border-[#262c33] text-center">
            <span className="text-xs text-gray-500">Permalink: </span>
            <a
              href={`/runs/${state.runId}`}
              className="text-xs text-blue-400 hover:text-blue-300 font-mono underline"
            >
              /runs/{state.runId}
            </a>
          </footer>
        )}
      </div>
    </div>
  );
}
