import React, { useState } from "react";
import type { StageNumber, StageStatus, StageEvent } from "@/agent/contracts";
import { StageEventLog } from "./StageEventLog";

export interface StagePanelProps {
  stageNumber: StageNumber;
  title: string;
  sourceFile: string;
  status: StageStatus;
  durationMs?: number;
  events?: StageEvent[];
  children?: React.ReactNode;
}

export function StagePanel({
  stageNumber,
  title,
  sourceFile,
  status,
  durationMs,
  events = [],
  children,
}: StagePanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const statusBadge: Record<StageStatus, { bg: string; icon: string }> = {
    pending: { bg: "bg-slate-900 text-slate-400 border-slate-700", icon: "⏸" },
    running: { bg: "bg-blue-950 text-blue-400 border-blue-700 animate-pulse", icon: "⚙" },
    complete: { bg: "bg-emerald-950 text-emerald-400 border-emerald-700", icon: "✓" },
    failed: { bg: "bg-red-950 text-red-400 border-red-700", icon: "✕" },
  };

  const badge = statusBadge[status];

  return (
    <div className="bg-[#14181d] border border-[#262c33] rounded-lg mb-4 shadow-sm overflow-hidden">
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="p-4 flex items-center justify-between cursor-pointer hover:bg-[#1a2027] transition-colors select-none"
      >
        <div className="flex items-center gap-3">
          <span className="w-7 h-7 rounded-full bg-[#262c33] text-gray-200 flex items-center justify-center font-bold text-xs">
            {stageNumber}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
              <span>{title}</span>
              <span className="text-[11px] font-mono text-gray-500 font-normal">({sourceFile})</span>
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {durationMs !== undefined && durationMs > 0 && (
            <span className="text-xs font-mono text-gray-400">{(durationMs / 1000).toFixed(2)}s</span>
          )}
          <span
            className={`px-2.5 py-0.5 rounded text-xs font-semibold uppercase border flex items-center gap-1 ${badge.bg}`}
          >
            <span>{badge.icon}</span>
            <span>{status}</span>
          </span>
          <span className="text-gray-400 text-xs">{isExpanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {isExpanded && (
        <div className="p-4 border-t border-[#262c33] bg-[#0d1014]">
          {status === "pending" ? (
            <div className="text-xs text-gray-500 italic py-2">Waiting for stage to start...</div>
          ) : (
            <>
              {children}
              <StageEventLog events={events} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
