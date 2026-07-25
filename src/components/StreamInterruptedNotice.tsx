"use client";

import React from "react";

export interface StreamInterruptedNoticeProps {
  elapsedMs: number;
  lastStageSeen: number;
  runId: string | null;
  onRetry: () => void;
  onReload: () => void;
}

export function StreamInterruptedNotice({
  elapsedMs,
  lastStageSeen,
  runId,
  onRetry,
  onReload,
}: StreamInterruptedNoticeProps) {
  const formattedTime = (elapsedMs / 1000).toFixed(1);

  return (
    <div className="bg-red-950/40 border border-red-800/80 rounded-lg p-4 mb-6 text-red-200">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-red-400 flex items-center gap-1.5 mb-1">
            <span>🚨</span>
            <span>Stream Interrupted</span>
          </h4>
          <p className="text-xs text-red-300/90 mb-2">
            The Server-Sent Events stream was disconnected after {formattedTime}s.
            {lastStageSeen > 0 ? ` Last active stage seen: Stage ${lastStageSeen}.` : ""}
            {" "}The run may still be completing server-side.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          {runId && (
            <button
              onClick={onReload}
              className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded text-xs font-semibold shadow transition-colors whitespace-nowrap"
            >
              Reload Results
            </button>
          )}
          <button
            onClick={onRetry}
            className="px-3 py-1.5 bg-red-800 hover:bg-red-700 text-white rounded text-xs font-semibold shadow transition-colors whitespace-nowrap"
          >
            Retry Pipeline Run
          </button>
        </div>
      </div>
    </div>
  );
}
