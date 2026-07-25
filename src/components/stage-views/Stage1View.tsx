"use client";

import React from "react";
import type { QualificationResult } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";

export function Stage1View({ output }: { output: unknown }) {
  if (!output || output === UNKNOWN) {
    return <div className="text-xs text-amber-400 italic">Stage 1 output is unknown or failed.</div>;
  }

  const data = output as QualificationResult;

  const fitBadge: Record<string, string> = {
    strong_fit: "bg-emerald-950 text-emerald-400 border-emerald-700",
    moderate_fit: "bg-amber-950 text-amber-400 border-amber-700",
    weak_fit: "bg-red-950 text-red-400 border-red-700",
  };

  return (
    <div className="space-y-4 text-xs">
      {/* Framework + Fit + Score header */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#14181d] p-3 rounded border border-[#262c33]">
        <div className="flex items-center gap-2">
          <span className="text-gray-400">Framework:</span>
          <span className="font-bold text-blue-400 font-mono text-sm">{data.framework}</span>
          <span className={`ml-2 px-2 py-0.5 rounded text-[10px] uppercase font-bold border ${fitBadge[data.fitAssessment] ?? "bg-slate-800 text-slate-300 border-slate-600"}`}>
            {data.fitAssessment.replace("_", " ")}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-gray-400">Priority Score:</span>
          <span className="font-mono text-base font-bold text-emerald-400">{data.priorityScore}/100</span>
        </div>
      </div>

      {/* Framework Selection Justification — Req 11.7: visible text */}
      <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
        <h4 className="text-gray-400 font-semibold mb-1">Framework Selection Justification:</h4>
        <p className="text-gray-200">{data.frameworkSelectionJustification}</p>
        {data.justificationLeadAttributes && data.justificationLeadAttributes.length > 0 && (
          <div className="mt-2 text-gray-500 font-mono text-[11px]">
            Based on lead attributes: {data.justificationLeadAttributes.join(", ")}
          </div>
        )}
      </div>

      {/* Score Reasoning — Req 11.7: visible text */}
      {data.scoreReasoning && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <h4 className="text-gray-400 font-semibold mb-1">Score Reasoning:</h4>
          <p className="text-gray-200">{data.scoreReasoning}</p>
        </div>
      )}

      {/* Scoring Rubric Breakdown — Req 11.7: visible text */}
      {data.scoreFactors && data.scoreFactors.length > 0 && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <h4 className="text-gray-400 font-semibold mb-2">Priority Score Factors:</h4>
          <div className="space-y-1">
            {data.scoreFactors.map((f, idx) => (
              <div key={idx} className="flex justify-between items-start gap-2 text-gray-300 font-mono">
                <div>
                  <span className="text-gray-200">{f.factor}</span>
                  <span className="text-gray-500 text-[11px] ml-2">{f.explanation}</span>
                </div>
                <span className={`font-bold whitespace-nowrap ${f.contribution >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {f.contribution >= 0 ? "+" : ""}{f.contribution} pts
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Known and Unknown Fields */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <h4 className="text-emerald-400 font-semibold mb-2">Known Fields ({data.knownFields?.length ?? 0}):</h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {data.knownFields?.map((kf, i) => (
              <div key={i} className="border-b border-[#262c33] pb-1.5 last:border-0">
                <div className="font-semibold text-gray-200">{kf.slotLabel}</div>
                <div className="text-gray-300 font-mono">{kf.value}</div>
                <div className="text-gray-500 text-[10px] italic">
                  Quote: &quot;{kf.evidenceQuote}&quot;
                  <span className="ml-2 text-gray-600">({kf.sourceLeadField})</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <h4 className="text-amber-400 font-semibold mb-2">Unknown Fields ({data.unknownFields?.length ?? 0}):</h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {data.unknownFields?.map((uf, i) => (
              <div key={i} className="border-b border-[#262c33] pb-1.5 last:border-0">
                <div className="font-semibold text-gray-200">{uf.slotLabel}</div>
                <div className="text-gray-400">{uf.whyItMatters}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
