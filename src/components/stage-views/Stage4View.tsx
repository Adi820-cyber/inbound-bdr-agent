"use client";

import React from "react";
import type { MatchResult, ScoredCaseStudy } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { SourceLink } from "../SourceLink";

function CaseStudyCard({ study, label }: { study: ScoredCaseStudy; label: string }) {
  const labelColor = label === "Winner" ? "emerald" : "blue";
  return (
    <div className={`bg-[#14181d] p-3 rounded border border-${labelColor}-900/60`}>
      <div className="flex justify-between items-start mb-2">
        <div>
          <span className={`px-2 py-0.5 bg-${labelColor}-950 text-${labelColor}-400 border border-${labelColor}-800 rounded font-bold text-[10px] uppercase`}>
            {label} Case Study (Rank #{study.rank})
          </span>
          <h4 className="font-bold text-sm text-gray-100 mt-1">
            {study.record.title !== "unknown" ? study.record.title : <span className="text-amber-400 italic">unknown title</span>}
          </h4>
        </div>
        <SourceLink url={study.record.sourceUrl} status={study.record.verificationStatus} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] mb-2">
        <div>
          <span className="text-gray-500">Industry: </span>
          <span className="text-gray-300">{study.record.industry !== "unknown" ? study.record.industry : "unknown"}</span>
        </div>
        <div>
          <span className="text-gray-500">Region: </span>
          <span className="text-gray-300">{study.record.region !== "unknown" ? study.record.region : "unknown"}</span>
        </div>
        <div>
          <span className="text-gray-500">Use Case: </span>
          <span className="text-gray-300">{study.record.useCase !== "unknown" ? study.record.useCase : "unknown"}</span>
        </div>
        <div>
          <span className="text-gray-500">Named Partner: </span>
          <span className="text-gray-300">{study.record.namedPartner !== "unknown" ? study.record.namedPartner : "unknown"}</span>
        </div>
      </div>

      {study.record.statedResults !== "unknown" && (
        <p className="text-gray-300 mb-3 text-[11px]">
          <span className="text-gray-500">Results: </span>{study.record.statedResults}
        </p>
      )}

      {/* Scoring Rubric Breakdown — Req 11.7: visible text */}
      <h5 className="font-semibold text-gray-400 mb-1 text-[11px]">
        Rubric Breakdown (Match Score: <span className="text-emerald-400 font-bold">{study.breakdown.matchScore.toFixed(4)}</span>):
      </h5>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-[11px]">
          <thead>
            <tr className="border-b border-[#262c33] text-gray-500">
              <th className="pb-1">Dimension</th>
              <th className="pb-1">Weight</th>
              <th className="pb-1">SubScore</th>
              <th className="pb-1">Contribution</th>
              <th className="pb-1">Lead Value</th>
              <th className="pb-1">Case Study Value</th>
              <th className="pb-1">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1f242c]">
            {study.breakdown.dimensions?.map((d, i) => (
              <tr key={i} className={`text-gray-300 ${d.unknownInput ? "opacity-60" : ""}`}>
                <td className="py-1 text-purple-300">{d.dimension}</td>
                <td className="py-1">{d.weight}</td>
                <td className="py-1 text-emerald-400 font-bold">{d.subScore.toFixed(2)}</td>
                <td className="py-1 text-cyan-300">{d.contribution.toFixed(4)}</td>
                <td className="py-1 text-gray-400 max-w-[100px] truncate">{d.leadValue}</td>
                <td className="py-1 text-gray-400 max-w-[100px] truncate">{d.caseStudyValue}</td>
                <td className="py-1 text-gray-500 text-[10px] max-w-[150px] truncate" title={d.reason}>{d.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Stage4View({ output }: { output: unknown }) {
  if (!output || output === UNKNOWN) {
    return <div className="text-xs text-amber-400 italic">Stage 4 output is unknown or failed.</div>;
  }

  const data = output as MatchResult;

  const winner = data.winner !== "unknown" ? data.winner : null;
  const runnerUp = data.runnerUp !== "unknown" ? data.runnerUp : null;

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#14181d] p-3 rounded border border-[#262c33]">
        <div className="flex flex-wrap gap-4">
          <div>
            <span className="text-gray-400">Corpus Size: </span>
            <span className="font-mono font-bold text-gray-200">{data.corpusSize}</span>
          </div>
          <div>
            <span className="text-gray-400">Provenance: </span>
            <span className="font-mono uppercase font-semibold text-blue-400">{data.corpusProvenance}</span>
          </div>
          {data.cachedSnapshotAt !== "unknown" && (
            <div>
              <span className="text-gray-400">Cached Snapshot: </span>
              <span className="font-mono text-amber-400">{data.cachedSnapshotAt}</span>
            </div>
          )}
        </div>

        {data.decidingDimensions && data.decidingDimensions.length > 0 && (
          <div>
            <span className="text-gray-400">Deciding Dimensions: </span>
            <span className="font-mono text-emerald-400 font-semibold">{data.decidingDimensions.join(", ")}</span>
          </div>
        )}
      </div>

      {/* Rubric Weights */}
      {data.rubricWeights && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <h4 className="text-gray-400 font-semibold mb-1 text-[11px]">Published Rubric Weights:</h4>
          <div className="flex gap-4 font-mono text-[11px]">
            {Object.entries(data.rubricWeights).map(([dim, w]) => (
              <span key={dim} className="text-gray-300">
                {dim}: <span className="text-blue-400 font-bold">{w}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {winner && <CaseStudyCard study={winner} label="Winner" />}
      {runnerUp && <CaseStudyCard study={runnerUp} label="Runner-Up" />}
      {!runnerUp && data.corpusSize < 2 && (
        <div className="bg-[#14181d] p-3 rounded border border-amber-900/60 text-amber-400 italic text-[11px]">
          Runner-up is unknown — corpus contains fewer than 2 case studies.
        </div>
      )}

      {data.comparisonStatement !== "unknown" && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33] text-gray-300">
          <span className="text-gray-400 font-semibold">Comparison Statement: </span>
          <span>{data.comparisonStatement}</span>
        </div>
      )}
    </div>
  );
}
