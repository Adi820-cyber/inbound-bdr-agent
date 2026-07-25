"use client";

import React from "react";
import type { ResearchReport } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { SourceLink } from "../SourceLink";

export function Stage2View({ output }: { output: unknown }) {
  if (!output || output === UNKNOWN) {
    return <div className="text-xs text-amber-400 italic">Stage 2 output is unknown or failed.</div>;
  }

  const data = output as ResearchReport;

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap justify-between items-center gap-3 bg-[#14181d] p-3 rounded border border-[#262c33]">
        <div>
          <span className="text-gray-400 font-semibold">Verified Claims: </span>
          <span className="font-mono text-sm font-bold text-emerald-400">{data.verifiedClaimCount}</span>
          <span className="text-gray-400 ml-4">Total Claims: </span>
          <span className="font-mono text-sm font-bold text-gray-200">{data.claims?.length ?? 0}</span>
        </div>
        {data.dimensionsWithNoSource && data.dimensionsWithNoSource.length > 0 && (
          <div>
            <span className="text-amber-400 font-semibold">Dimensions with no source: </span>
            <span className="font-mono text-amber-300">{data.dimensionsWithNoSource.join(", ")}</span>
          </div>
        )}
      </div>

      <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
        <h4 className="text-gray-400 font-semibold mb-2">Research Claims ({data.claims?.length ?? 0}):</h4>
        <div className="space-y-3">
          {data.claims?.map((claim, idx) => (
            <div key={idx} className="bg-[#0b0d10] p-2.5 rounded border border-[#262c33]">
              <div className="flex justify-between items-start gap-2 mb-1">
                <span className="font-mono text-[11px] text-purple-400 font-semibold">
                  [{claim.dimension}] {claim.claimId}
                </span>
                <SourceLink
                  url={claim.sourceUrl}
                  status={claim.verificationStatus}
                  retrievedAt={claim.retrievedAt !== "unknown" ? claim.retrievedAt : undefined}
                />
              </div>
              <p className="text-gray-200 mb-1">
                {claim.claimText !== "unknown" ? claim.claimText : <span className="text-amber-400 italic">unknown</span>}
              </p>
              {claim.supportingQuote && claim.supportingQuote !== "unknown" && (
                <div className="text-gray-400 italic text-[11px] bg-[#14181d] p-1.5 rounded">
                  Quote: &quot;{claim.supportingQuote}&quot;
                </div>
              )}
              {claim.rejectionReason && (
                <div className="text-red-400 text-[11px] mt-1">
                  ⚠ Rejected: {claim.rejectionReason}
                </div>
              )}
              {claim.numericFigures && claim.numericFigures.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {claim.numericFigures.map((fig, fi) => (
                    <div key={fi} className="text-[11px] font-mono text-cyan-300">
                      📊 {fig.label}: {fig.value}
                      <SourceLink url={fig.sourceUrl} className="ml-2" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {data.positioningRecommendation && (
        <div className="bg-[#14181d] p-3 rounded border border-[#262c33]">
          <h4 className="text-gray-400 font-semibold mb-1">Positioning Recommendation:</h4>
          <p className="text-gray-200 mb-2">{data.positioningRecommendation.narrative}</p>
          <div className="space-y-1">
            {data.positioningRecommendation.assertions?.map((a, i) => (
              <div key={i} className="text-gray-300 text-[11px]">
                • {a.assertion}{" "}
                <span className="text-gray-500 font-mono">({a.supportingClaimIds?.join(", ")})</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
