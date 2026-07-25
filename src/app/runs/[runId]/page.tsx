"use client";

import React, { useEffect, useState, use } from "react";
import type { RunArtifact } from "@/agent/contracts";
import { RunStatusBar } from "@/components/RunStatusBar";
import { StagePanel } from "@/components/StagePanel";
import { LimitationsPanel } from "@/components/LimitationsPanel";

import { Stage1View } from "@/components/stage-views/Stage1View";
import { Stage2View } from "@/components/stage-views/Stage2View";
import { Stage3View } from "@/components/stage-views/Stage3View";
import { Stage4View } from "@/components/stage-views/Stage4View";
import { Stage5View } from "@/components/stage-views/Stage5View";
import { Stage6View } from "@/components/stage-views/Stage6View";

/**
 * Extract durationMs from a StageRecord, narrowing Maybe<number>.
 * Returns undefined when the value is "unknown".
 */
function durationOrUndefined(durationMs: number | "unknown"): number | undefined {
  return durationMs !== "unknown" ? durationMs : undefined;
}

/**
 * Safely extract verifiedClaimCount from stage2 output.
 * The output is `ResearchReport | "unknown"`. We narrow before accessing.
 */
function getVerifiedClaimCount(artifact: RunArtifact): number {
  const output = artifact.stages.stage2.output;
  if (output !== "unknown" && typeof output === "object" && output !== null && "verifiedClaimCount" in output) {
    return output.verifiedClaimCount;
  }
  return 0;
}

export default function StoredRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [artifact, setArtifact] = useState<RunArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRun() {
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) {
          setError(`Run ID "${runId}" not found (HTTP ${res.status}).`);
          setLoading(false);
          return;
        }
        const data: RunArtifact = await res.json();
        setArtifact(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load stored run artifact.");
      } finally {
        setLoading(false);
      }
    }
    fetchRun();
  }, [runId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0d10] text-[#e6e9ed] flex items-center justify-center p-4">
        <div className="text-sm font-mono text-blue-400 animate-pulse">Loading stored run artifact ({runId})...</div>
      </div>
    );
  }

  if (error || !artifact) {
    return (
      <div className="min-h-screen bg-[#0b0d10] text-[#e6e9ed] flex items-center justify-center p-4">
        <div className="bg-[#14181d] border border-red-800 p-6 rounded-lg max-w-md text-center">
          <h2 className="text-lg font-bold text-red-400 mb-2">Run Not Found</h2>
          <p className="text-xs text-gray-300 mb-4">{error ?? `No artifact found for runId: ${runId}`}</p>
          <a href="/" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold">
            Return to Run Console
          </a>
        </div>
      </div>
    );
  }

  const getStageEvents = (stageNum: number) => {
    return artifact.events?.filter((e) => e.stage === stageNum) ?? [];
  };

  return (
    <div suppressHydrationWarning className="min-h-screen bg-[#0b0d10] text-[#e6e9ed] font-sans antialiased p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex items-center justify-between border-b border-[#262c33] pb-4">
          <div>
            <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">Stored Run Artifact</span>
            <h1 className="text-xl font-bold text-white mt-1">Run: {artifact.runId}</h1>
            <p className="text-xs text-gray-400 mt-0.5 font-mono">
              Lead: {artifact.leadProfile.company !== "unknown" ? artifact.leadProfile.company : "unknown"} |{" "}
              {artifact.leadProfile.senderName !== "unknown" ? artifact.leadProfile.senderName : "unknown"}
            </p>
          </div>
          <a href="/" className="text-xs font-mono text-blue-400 hover:text-blue-300 underline">
            ← Back to Console
          </a>
        </header>

        <RunStatusBar
          status={artifact.status}
          runId={artifact.runId}
          elapsedMs={0}
          verifiedClaimCount={getVerifiedClaimCount(artifact)}
          isDurable={artifact.providerConfig.runStoreDurable}
        />

        <main className="space-y-4">
          <StagePanel
            stageNumber={1}
            title="Qualification & Fit Assessment"
            sourceFile={artifact.stages.stage1.sourceFile}
            status={artifact.stages.stage1.status}
            durationMs={durationOrUndefined(artifact.stages.stage1.durationMs)}
            events={getStageEvents(1)}
          >
            <Stage1View output={artifact.stages.stage1.output} />
          </StagePanel>

          <StagePanel
            stageNumber={2}
            title="Account Research & Provenance"
            sourceFile={artifact.stages.stage2.sourceFile}
            status={artifact.stages.stage2.status}
            durationMs={durationOrUndefined(artifact.stages.stage2.durationMs)}
            events={getStageEvents(2)}
          >
            <Stage2View output={artifact.stages.stage2.output} />
          </StagePanel>

          <StagePanel
            stageNumber={3}
            title="Adaptive Response Sequence"
            sourceFile={artifact.stages.stage3.sourceFile}
            status={artifact.stages.stage3.status}
            durationMs={durationOrUndefined(artifact.stages.stage3.durationMs)}
            events={getStageEvents(3)}
          >
            <Stage3View output={artifact.stages.stage3.output} />
          </StagePanel>

          <StagePanel
            stageNumber={4}
            title="Attribute-Driven Case Study Match"
            sourceFile={artifact.stages.stage4.sourceFile}
            status={artifact.stages.stage4.status}
            durationMs={durationOrUndefined(artifact.stages.stage4.durationMs)}
            events={getStageEvents(4)}
          >
            <Stage4View output={artifact.stages.stage4.output} />
          </StagePanel>

          <StagePanel
            stageNumber={5}
            title="GTM Motion & Partner Strategy"
            sourceFile={artifact.stages.stage5.sourceFile}
            status={artifact.stages.stage5.status}
            durationMs={durationOrUndefined(artifact.stages.stage5.durationMs)}
            events={getStageEvents(5)}
          >
            <Stage5View output={artifact.stages.stage5.output} />
          </StagePanel>

          <StagePanel
            stageNumber={6}
            title="AE Handoff Summary"
            sourceFile={artifact.stages.stage6.sourceFile}
            status={artifact.stages.stage6.status}
            durationMs={durationOrUndefined(artifact.stages.stage6.durationMs)}
            events={getStageEvents(6)}
          >
            <Stage6View output={artifact.stages.stage6.output} />
          </StagePanel>

          <LimitationsPanel items={artifact.unknownFieldReport} />
        </main>

        <footer className="mt-8 pt-4 border-t border-[#262c33] text-center text-xs text-gray-500">
          <span>Started: {artifact.startedAt}</span>
          {artifact.completedAt !== "unknown" && (
            <span className="ml-4">Completed: {artifact.completedAt}</span>
          )}
        </footer>
      </div>
    </div>
  );
}
