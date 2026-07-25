"use client";

import React from "react";
import type { RunArtifact } from "@/agent/contracts";

export interface LimitationsPanelProps {
  items: RunArtifact["unknownFieldReport"];
}

export function LimitationsPanel({ items }: LimitationsPanelProps) {
  if (!items || items.length === 0) return null;

  return (
    <div className="bg-[#14181d] border border-amber-900/60 rounded-lg p-4 mb-6">
      <h4 className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-2 flex items-center gap-1.5">
        <span>⚠️</span>
        <span>Run Limitations &amp; Unknown Fields Report ({items.length})</span>
      </h4>

      <p className="text-xs text-gray-400 mb-3">
        Per the anti-fabrication core rules, unverified facts or missing sources resolve to{" "}
        <code className="text-amber-300 font-mono bg-[#0b0d10] px-1 py-0.5 rounded">&quot;unknown&quot;</code>{" "}
        rather than placeholder guesses.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs font-mono">
          <thead>
            <tr className="border-b border-[#262c33] text-gray-500">
              <th className="pb-1.5">Dimension</th>
              <th className="pb-1.5">Field Path</th>
              <th className="pb-1.5">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1f242c]">
            {items.map((item, idx) => (
              <tr key={idx} className="text-gray-300">
                <td className="py-1.5 text-amber-400/90">
                  {item.dimension !== "unknown" ? item.dimension : "pipeline"}
                </td>
                <td className="py-1.5 text-gray-200 font-semibold">{item.field}</td>
                <td className="py-1.5 text-gray-400">{item.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
