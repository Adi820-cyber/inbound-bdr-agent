import React, { useState } from "react";
import type { RawEmailRecord } from "@/agent/contracts";
import { FIXED_LEAD } from "@/agent/fixed-lead";

export interface LeadEditorProps {
  onSaveLead: (lead: RawEmailRecord) => void;
  currentLead?: RawEmailRecord;
}

export function LeadEditor({ onSaveLead, currentLead = FIXED_LEAD }: LeadEditorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [lead, setLead] = useState<RawEmailRecord>(currentLead);

  const handleReset = () => {
    setLead(FIXED_LEAD);
    onSaveLead(FIXED_LEAD);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveLead(lead);
    setIsOpen(false);
  };

  return (
    <div className="mb-6 border border-[#262c33] bg-[#14181d] rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400">
            Inbound Lead Record
          </h4>
          <p className="text-xs text-gray-300 font-semibold mt-0.5">
            {lead.fromName} ({lead.fromEmail}) — {lead.subject}
          </p>
        </div>

        <button
          onClick={() => setIsOpen(!isOpen)}
          className="text-xs font-mono text-blue-400 hover:text-blue-300 underline"
        >
          {isOpen ? "Close Editor" : "Edit Inbound Lead"}
        </button>
      </div>

      {isOpen && (
        <form onSubmit={handleSubmit} className="mt-4 border-t border-[#262c33] pt-4 space-y-3 text-xs">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-gray-400 mb-1">From Name</label>
              <input
                type="text"
                value={lead.fromName}
                onChange={(e) => setLead({ ...lead, fromName: e.target.value })}
                className="w-full bg-[#0b0d10] border border-[#262c33] p-2 rounded text-gray-200"
              />
            </div>
            <div>
              <label className="block text-gray-400 mb-1">From Email</label>
              <input
                type="email"
                value={lead.fromEmail}
                onChange={(e) => setLead({ ...lead, fromEmail: e.target.value })}
                className="w-full bg-[#0b0d10] border border-[#262c33] p-2 rounded text-gray-200"
              />
            </div>
          </div>

          <div>
            <label className="block text-gray-400 mb-1">Subject</label>
            <input
              type="text"
              value={lead.subject}
              onChange={(e) => setLead({ ...lead, subject: e.target.value })}
              className="w-full bg-[#0b0d10] border border-[#262c33] p-2 rounded text-gray-200"
            />
          </div>

          <div>
            <label className="block text-gray-400 mb-1">Email Body</label>
            <textarea
              rows={6}
              value={lead.body}
              onChange={(e) => setLead({ ...lead, body: e.target.value })}
              className="w-full bg-[#0b0d10] border border-[#262c33] p-2 rounded text-gray-200 font-mono text-[11px]"
            />
          </div>

          <div className="flex justify-between items-center pt-2">
            <button
              type="button"
              onClick={handleReset}
              className="px-3 py-1.5 bg-[#262c33] hover:bg-[#323942] text-gray-300 rounded"
            >
              Reset to Fixed Lead (SQM / Rodrigo Castillo)
            </button>

            <button
              type="submit"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded shadow"
            >
              Apply Lead Record
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
