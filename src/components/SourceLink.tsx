import React from "react";
import type { VerificationStatus } from "@/agent/contracts";

export interface SourceLinkProps {
  url: string | null | undefined;
  label?: string;
  status?: VerificationStatus;
  retrievedAt?: string | null;
  className?: string;
}

export function SourceLink({
  url,
  label,
  status = "verified",
  retrievedAt,
  className = "",
}: SourceLinkProps) {
  if (!url || url === "unknown") {
    return <span className="text-gray-500 italic text-sm">(Unverified / Unknown Source)</span>;
  }

  const badgeColors: Record<VerificationStatus, string> = {
    verified: "bg-emerald-950/80 text-emerald-400 border-emerald-700/60",
    stale: "bg-amber-950/80 text-amber-400 border-amber-700/60",
    unknown: "bg-red-950/80 text-red-400 border-red-700/60",
  };

  const displayText = label || url;
  const hoverTitle = retrievedAt
    ? `Status: ${status} | Retrieved at: ${retrievedAt}`
    : `Status: ${status}`;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-mono ${className}`}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={hoverTitle}
        className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40 underline-offset-2 transition-colors break-all"
      >
        {displayText}
      </a>
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold border ${badgeColors[status]}`}
        title={hoverTitle}
      >
        {status}
      </span>
    </span>
  );
}
