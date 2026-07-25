"use client";

import React from "react";
import type { RawEmailRecord } from "@/agent/contracts";

export interface RunTriggerProps {
  onTrigger: (rawEmail?: RawEmailRecord) => void;
  isRunning: boolean;
  leadRecord?: RawEmailRecord;
}

export function RunTrigger({ onTrigger, isRunning, leadRecord }: RunTriggerProps) {
  return (
    <button
      onClick={() => onTrigger(leadRecord)}
      disabled={isRunning}
      className={`px-6 py-3 rounded-lg font-bold text-sm shadow-lg transition-all flex items-center gap-2 ${
        isRunning
          ? "bg-blue-900 text-blue-300 cursor-not-allowed border border-blue-700"
          : "bg-blue-600 hover:bg-blue-500 text-white border border-blue-400 active:scale-95"
      }`}
    >
      <span>{isRunning ? "⚙ Running Pipeline..." : "🚀 Run Agent Pipeline"}</span>
    </button>
  );
}
