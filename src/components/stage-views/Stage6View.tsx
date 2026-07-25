"use client";

import React from "react";
import type { HandoffSummary } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { SourceLink } from "../SourceLink";

export function Stage6View({ output }: { output: unknown }) {
  if (!output || output === UNKNOWN) {
    return <div className="text-xs text-amber-400 italic">Stage 6 output is unknown or failed.</div>;
  }

  const data = output as HandoffSummary;

  return (
    <div className="space-y-4 text-xs">
      {/* 1. Buyer Context */}
      <div className="bg-[#14181d] p-3.5 rounded border border-[#262c33]">
        <h4 className="text-blue-400 font-bold uppercase tracking-wider text-[11px] mb-1">1. Buyer Context</h4>
        <p className="text-gray-200 leading-relaxed">{data.buyerContext}</p>
      </div>

      {/* 2. Qualification Status Summary */}
      <div className="bg-[#14181d] p-3.5 rounded border border-[#262c33]">
        <h4 className="text-blue-400 font-bold uppercase tracking-wider text-[11px] mb-2">2. Qualification Status Summary</h4>
        <div className="flex flex-wrap gap-4 font-mono text-gray-300 text-[11px]">
          <div>Framework: <span className="text-white font-bold">{data.qualificationStatus.framework}</span></div>
          <div>Priority Score: <span className="text-emerald-400 font-bold">{data.qualificationStatus.priorityScore}/100</span></div>
          <div>Fit: <span className="text-amber-400 font-bold">{data.qualificationStatus.fitAssessment.replace("_", " ")}</span></div>
          <div>Known Fields: <span className="text-white font-bold">{data.qualificationStatus.knownFieldCount}</span></div>
        </div>
        {data.qualificationStatus.unknownSlotLabels && data.qualificationStatus.unknownSlotLabels.length > 0 && (
          <div className="mt-2 text-[11px]">
            <span className="text-amber-400">Unknown Slots: </span>
            <span className="text-gray-400 font-mono">{data.qualificationStatus.unknownSlotLabels.join(", ")}</span>
          </div>
        )}
      </div>

      {/* 3. Top Three Research Findings */}
      <div className="bg-[#14181d] p-3.5 rounded border border-[#262c33]">
        <div className="flex justify-between items-center mb-2">
          <h4 className="text-blue-400 font-bold uppercase tracking-wider text-[11px]">
            3. Top Verified Findings ({data.verifiedFindingsAvailable} Available)
          </h4>
        </div>
        <div className="space-y-2">
          {data.topThreeFindings.map((tf, i) => (
            <div key={i} className="bg-[#0b0d10] p-2.5 rounded border border-[#262c33] flex justify-between items-start gap-3">
              <div>
                <span className="font-mono text-purple-400 font-bold text-[11px] mr-2">
                  #{i + 1} [{tf.claimId !== "unknown" ? tf.claimId : "unknown"}]
                </span>
                <span className="text-gray-200">
                  {tf.finding !== "unknown" ? tf.finding : <span className="text-amber-400 italic">unknown</span>}
                </span>
              </div>
              <SourceLink url={tf.sourceUrl} />
            </div>
          ))}
        </div>
      </div>

      {/* 4. Recommended Case Study */}
      <div className="bg-[#14181d] p-3.5 rounded border border-[#262c33]">
        <h4 className="text-blue-400 font-bold uppercase tracking-wider text-[11px] mb-1">4. Recommended Case Study</h4>
        <div className="flex justify-between items-start mb-1">
          <h5 className="font-bold text-gray-100">
            {data.recommendedCaseStudy.title !== "unknown"
              ? data.recommendedCaseStudy.title
              : <span className="text-amber-400 italic">unknown</span>}
          </h5>
          <SourceLink url={data.recommendedCaseStudy.sourceUrl} />
        </div>
        {data.recommendedCaseStudy.whyItWon !== "unknown" && (
          <p className="text-gray-300 italic text-[11px]">Why it won: {data.recommendedCaseStudy.whyItWon}</p>
        )}
      </div>

      {/* 5. Suggested Next Step */}
      <div className="bg-[#14181d] p-3.5 rounded border border-emerald-900/60">
        <h4 className="text-emerald-400 font-bold uppercase tracking-wider text-[11px] mb-1">5. Suggested Next Step</h4>
        <div className="font-bold text-sm text-gray-100 mb-1">{data.suggestedNextStep.action}</div>
        <p className="text-gray-300 mb-2">{data.suggestedNextStep.rationale}</p>
        <div className="text-gray-500 font-mono text-[11px]">
          Consistent with motion:{" "}
          <span className="text-emerald-400 font-bold">
            {data.suggestedNextStep.consistentWithMotion !== "unknown"
              ? data.suggestedNextStep.consistentWithMotion
              : "unknown"}
          </span>
        </div>
      </div>
    </div>
  );
}
