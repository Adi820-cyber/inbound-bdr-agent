"use client";

import React from "react";
import type { EmailSequence } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";

export function Stage3View({ output }: { output: unknown }) {
  if (!output || output === UNKNOWN) {
    return <div className="text-xs text-amber-400 italic">Stage 3 output is unknown or failed.</div>;
  }

  const data = output as EmailSequence;

  return (
    <div className="space-y-4 text-xs">
      {/* Persona Adaptation Note — Req 11.7: visible */}
      {data.personaAdaptationNote && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33] text-gray-300">
          <span className="text-blue-400 font-semibold">Persona Adaptation Note: </span>
          <span>{data.personaAdaptationNote}</span>
        </div>
      )}

      {/* Research Unavailable Notice */}
      {data.researchUnavailableNotice && data.researchUnavailableNotice !== "unknown" && (
        <div className="bg-amber-950/60 p-3 rounded border border-amber-800 text-amber-300">
          <span className="font-semibold">Research Unavailable Notice: </span>
          <span>{data.researchUnavailableNotice}</span>
        </div>
      )}

      {/* Covered Unknown Slots */}
      {data.coveredUnknownSlotIds && data.coveredUnknownSlotIds.length > 0 && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33] text-[11px]">
          <span className="text-gray-400 font-semibold">Unknown Slots Covered Across Sequence: </span>
          <span className="text-amber-400 font-mono">{data.coveredUnknownSlotIds.join(", ")}</span>
          <span className="text-gray-500 ml-2">({data.coveredUnknownSlotIds.length} distinct)</span>
        </div>
      )}

      {/* Email Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        {data.emails?.map((email, idx) => (
          <div key={idx} className="bg-[#14181d] p-3 rounded border border-[#262c33] flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-2 pb-1 border-b border-[#262c33]">
                <span className="font-bold text-gray-200">Email #{email.position}</span>
                <span className="font-mono text-[11px] text-blue-400 font-semibold">{email.sendTimingGuidance}</span>
              </div>
              <div className="font-semibold text-gray-300 mb-1">Subject: {email.subject}</div>
              <div className="bg-[#0b0d10] p-2 rounded text-gray-300 font-mono text-[11px] whitespace-pre-wrap max-h-48 overflow-y-auto mb-2">
                {email.body}
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t border-[#262c33] text-[11px]">
              <div>
                <span className="text-gray-500">Referenced Claims: </span>
                <span className="text-cyan-400 font-mono">{email.referencedClaimIds?.join(", ")}</span>
              </div>
              <div>
                <span className="text-gray-500">Targeted Unknown Slots: </span>
                <span className="text-amber-400 font-mono">{email.targetedUnknownSlotIds?.join(", ")}</span>
              </div>

              {/* Progression Rationale — Req 11.7: visible text */}
              {email.position > 1 && (
                <div className="bg-[#0b0d10] p-1.5 rounded text-gray-300">
                  <span className="text-gray-400 font-semibold">Progression Rationale: </span>
                  <span className="text-gray-200">
                    {email.progressionRationale !== "unknown"
                      ? email.progressionRationale
                      : <span className="text-amber-400 italic">unknown</span>}
                  </span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
