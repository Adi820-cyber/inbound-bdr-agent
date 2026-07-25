"use client";

import React from "react";
import type { GtmRecommendation } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { SourceLink } from "../SourceLink";

export function Stage5View({ output }: { output: unknown }) {
  if (!output || output === UNKNOWN) {
    return <div className="text-xs text-amber-400 italic">Stage 5 output is unknown or failed.</div>;
  }

  const data = output as GtmRecommendation;

  const motionBadge: Record<string, { bg: string; label: string }> = {
    partner_led: { bg: "bg-purple-950 text-purple-400 border-purple-800", label: "PARTNER-LED MOTION" },
    direct_ae: { bg: "bg-blue-950 text-blue-400 border-blue-800", label: "DIRECT AE MOTION" },
  };

  const badge = motionBadge[data.motion] ?? { bg: "bg-slate-800 text-slate-300 border-slate-600", label: data.motion };

  return (
    <div className="space-y-4 text-xs">
      <div className="flex justify-between items-center bg-[#14181d] p-3 rounded border border-[#262c33]">
        <span className="text-gray-400 font-semibold">Recommended Motion:</span>
        <span className={`px-3 py-1 rounded text-xs font-bold uppercase border ${badge.bg}`}>
          {badge.label}
        </span>
      </div>

      {/* GTM Motion Reasoning — Req 11.7: visible text */}
      <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
        <h4 className="text-gray-400 font-semibold mb-1">GTM Motion Reasoning:</h4>
        <p className="text-gray-200">{data.reasoning}</p>
      </div>

      {/* Geography */}
      {data.geographyConsidered !== "unknown" && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <span className="text-gray-400 font-semibold">Geography Considered: </span>
          <span className="text-gray-200">{data.geographyConsidered}</span>
        </div>
      )}

      {/* Complexity Assessment */}
      {data.complexity && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-gray-400 font-semibold">Complexity Assessment:</h4>
            <span className="font-mono font-bold text-amber-400">Score: {data.complexity.complexityScore}</span>
          </div>
          <p className="text-gray-300 mb-2">{data.complexity.explanation}</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px] font-mono">
            <div>
              <span className="text-gray-500">Site Count: </span>
              <span className="text-gray-200">
                {data.complexity.signals.siteCount !== "unknown" ? data.complexity.signals.siteCount : "unknown"}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Continuous Ops: </span>
              <span className={data.complexity.signals.continuousOperations ? "text-emerald-400" : "text-gray-400"}>
                {String(data.complexity.signals.continuousOperations)}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Regulated: </span>
              <span className={data.complexity.signals.regulatedEnvironment ? "text-emerald-400" : "text-gray-400"}>
                {String(data.complexity.signals.regulatedEnvironment)}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Multi-Stakeholder: </span>
              <span className={data.complexity.signals.multiStakeholder ? "text-emerald-400" : "text-gray-400"}>
                {String(data.complexity.signals.multiStakeholder)}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Deal Size: </span>
              <span className="text-gray-200">{data.complexity.signals.dealSizeIndicator}</span>
            </div>
          </div>
        </div>
      )}

      {/* Partner Type */}
      {data.motion === "partner_led" && data.partnerType !== "unknown" && (
        <div className="bg-[#14181d] p-3 rounded border border-purple-900/60">
          <span className="text-gray-400 font-semibold">Partner Type: </span>
          <span className="text-purple-400 font-mono font-bold">{data.partnerType}</span>
        </div>
      )}

      {/* Regional Partner Evidence */}
      {data.regionalPartnerEvidence !== "unknown" && data.regionalPartnerEvidence.found ? (
        <div className="bg-[#14181d] p-3 rounded border border-purple-900/60">
          <div className="flex justify-between items-start mb-1">
            <h4 className="font-bold text-purple-400">Regional Partner Evidence Found:</h4>
            <SourceLink url={data.regionalPartnerEvidence.sourceUrl} />
          </div>
          <div className="text-gray-200 font-semibold">
            {data.regionalPartnerEvidence.partnerNames?.join(", ")}
          </div>
          {data.regionalPartnerEvidence.supportingQuote !== "unknown" && data.regionalPartnerEvidence.supportingQuote && (
            <p className="text-gray-400 italic text-[11px] mt-1 bg-[#0b0d10] p-1.5 rounded">
              &quot;{data.regionalPartnerEvidence.supportingQuote}&quot;
            </p>
          )}
        </div>
      ) : (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33] text-gray-400 italic">
          No regional partner evidence found.
          {data.derivedWithoutPartnerEvidence && (
            <span className="ml-2 text-amber-400 font-semibold not-italic text-[11px]">
              ⚠ GTM motion derived without partner evidence (Req 9.5)
            </span>
          )}
        </div>
      )}

      {/* Decision Inputs Snapshot */}
      {data.decisionInputsSnapshot && Object.keys(data.decisionInputsSnapshot).length > 0 && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <h4 className="text-gray-400 font-semibold mb-1 text-[11px]">Decision Inputs Snapshot (Audit Trail):</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-[11px] font-mono">
            {Object.entries(data.decisionInputsSnapshot).map(([k, v]) => (
              <div key={k}>
                <span className="text-gray-500">{k}: </span>
                <span className="text-gray-300">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
