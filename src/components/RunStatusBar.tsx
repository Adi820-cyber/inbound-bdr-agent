import React from "react";
import type { RunStatus } from "@/agent/contracts";

export interface RunStatusBarProps {
  status: RunStatus | "idle";
  runId: string | null;
  elapsedMs: number;
  verifiedClaimCount?: number;
  isDurable?: boolean;
}

export function RunStatusBar({
  status,
  runId,
  elapsedMs,
  verifiedClaimCount = 0,
  isDurable = false,
}: RunStatusBarProps) {
  const statusStyles: Record<RunStatus | "idle", { bg: string; label: string }> = {
    idle: { bg: "bg-slate-800 text-slate-300 border-slate-700", label: "IDLE" },
    running: { bg: "bg-blue-950 text-blue-400 border-blue-700 animate-pulse", label: "RUNNING" },
    complete: { bg: "bg-emerald-950 text-emerald-400 border-emerald-700", label: "COMPLETE" },
    partial: { bg: "bg-amber-950 text-amber-400 border-amber-700", label: "PARTIAL" },
    failed: { bg: "bg-red-950 text-red-400 border-red-700", label: "FAILED" },
  };

  const currentStatus = statusStyles[status];
  const formattedTime = (elapsedMs / 1000).toFixed(1);

  return (
    <header className="bg-[#14181d] border border-[#262c33] rounded-lg p-4 mb-6 shadow-md flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span
          className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${currentStatus.bg}`}
        >
          {currentStatus.label}
        </span>
        {runId && (
          <span className="text-xs font-mono text-gray-400">
            ID: <span className="text-gray-200">{runId}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-6 text-xs text-gray-300">
        <div>
          <span className="text-gray-500">Duration: </span>
          <span className="font-mono font-semibold">{formattedTime}s</span>
        </div>

        <div>
          <span className="text-gray-500">Verified Claims: </span>
          <span className="font-mono font-semibold text-emerald-400">{verifiedClaimCount}</span>
        </div>

        <div>
          <span className="text-gray-500">Run Store: </span>
          <span
            className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold border ${
              isDurable
                ? "bg-emerald-950 text-emerald-400 border-emerald-800"
                : "bg-amber-950 text-amber-400 border-amber-800"
            }`}
          >
            {isDurable ? "Upstash (Durable)" : "JSON File (Dev)"}
          </span>
        </div>
      </div>
    </header>
  );
}
