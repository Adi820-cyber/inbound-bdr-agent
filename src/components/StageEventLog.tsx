import React, { useState } from "react";
import type { StageEvent } from "@/agent/contracts";

export interface StageEventLogProps {
  events: StageEvent[];
}

export function StageEventLog({ events }: StageEventLogProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!events || events.length === 0) return null;

  return (
    <div className="mt-4 border-t border-[#262c33] pt-3">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5 font-mono mb-2 transition-colors"
      >
        <span>{isOpen ? "▼" : "▶"}</span>
        <span>Trace & Event Log ({events.length} events)</span>
      </button>

      {isOpen && (
        <div className="bg-[#0b0d10] border border-[#262c33] rounded p-3 text-xs font-mono max-h-60 overflow-y-auto space-y-2">
          {events.map((evt) => (
            <div key={`${evt.seq}-${evt.eventId}`} className="border-b border-[#1f242c] pb-1.5 last:border-0">
              <div className="flex items-center justify-between text-gray-500 text-[11px] mb-0.5">
                <span className="text-blue-400 font-semibold">#{evt.seq} [{evt.type}]</span>
                <span>{new Date(evt.timestamp).toLocaleTimeString()}</span>
              </div>
              <p className="text-gray-300">{evt.message}</p>

              {evt.llmCall && (
                <div className="mt-1 text-[11px] text-gray-400 bg-[#14181d] p-1.5 rounded">
                  Model: <span className="text-purple-300">{evt.llmCall.model}</span> ({evt.llmCall.provider})
                  {evt.llmCall.fallbackModelUsed && (
                    <span className="ml-2 text-amber-400 font-semibold">[Fallback Model Used]</span>
                  )}
                  {evt.llmCall.promptTokens !== undefined && (
                    <span className="ml-2">Tokens: {evt.llmCall.promptTokens} in / {evt.llmCall.completionTokens} out</span>
                  )}
                </div>
              )}

              {evt.toolCall && (
                <div className="mt-1 text-[11px] text-gray-400 bg-[#14181d] p-1.5 rounded">
                  Tool: <span className="text-cyan-300">{evt.toolCall.kind}</span> — {evt.toolCall.urlOrQuery}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
