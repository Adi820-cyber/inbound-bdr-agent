/**
 * AE handoff delivery (Stage 6 side channel).
 *
 * Once a run finishes, the Stage 6 handoff summary is worth pushing to wherever
 * the AE actually lives — a Slack channel, a CRM webhook, an internal queue.
 * This module builds a compact, readable payload from the run artifact and hands
 * it to the notification transport.
 *
 * Design rules:
 *  - OPTIONAL BY CONSTRUCTION. `AE_HANDOFF_WEBHOOK_URL` is an optional env var.
 *    When it is unset, `deliverHandoff` returns
 *    `{ delivered: false, channel: "none", reason: … }`. It never throws, and
 *    the run that produced the artifact is never affected.
 *  - NO EGRESS HERE. Raw web egress is confined to `src/research/**` and
 *    `src/providers/**` (Req 13.4), so the actual POST lives in
 *    `src/providers/notify/webhook.ts` and is imported.
 *  - NO SECRETS, NO INVENTION. The payload carries run facts only; a field the
 *    run could not determine is reported as the `"unknown"` marker rather than
 *    guessed, and provider keys never enter the payload.
 *  - SLACK-COMPATIBLE. Alongside the structured fields the payload carries a
 *    `text` field holding a markdown summary, which is exactly what a Slack
 *    incoming webhook renders.
 */

import type {
  GtmRecommendation,
  HandoffSummary,
  Maybe,
  QualificationResult,
  RunArtifact,
} from "./contracts";
import { UNKNOWN } from "./contracts";
import { getAeHandoffWebhookUrl } from "@/lib/config/env";
import { postJson } from "@/providers/notify/webhook";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface DeliverHandoffOptions {
  /** Overrides the env-configured destination. Used by tests and callers with their own routing. */
  webhookUrl?: string;
  /** Origin used to make the permalink absolute, e.g. `https://bdr.example.com`. */
  baseUrl?: string;
  /** Injectable transport; defaults to the notify provider's `postJson`. */
  post?: typeof postJson;
}

export interface DeliverHandoffResult {
  delivered: boolean;
  /** `"none"` when not configured, `"webhook"` when a POST was attempted. */
  channel: string;
  /** Why delivery did not happen (or failed). Absent on success. */
  reason?: string;
}

export interface HandoffFindingPayload {
  finding: Maybe<string>;
  sourceUrl: Maybe<string>;
}

export interface HandoffDeliveryPayload {
  runId: string;
  permalink: string;
  status: RunArtifact["status"];
  company: Maybe<string>;
  priorityScore: Maybe<number>;
  fitAssessment: Maybe<string>;
  gtmMotion: Maybe<string>;
  recommendedCaseStudyUrl: Maybe<string>;
  topFindings: HandoffFindingPayload[];
  /** Markdown summary; what a Slack incoming webhook renders. */
  text: string;
}

// ---------------------------------------------------------------------------
// Artifact readers — every one tolerates a failed/degraded stage
// ---------------------------------------------------------------------------

function stageOutput<T>(output: T | typeof UNKNOWN): T | undefined {
  return output === UNKNOWN ? undefined : output;
}

/** Builds the run permalink; absolute when a base URL is supplied. */
export function runPermalink(runId: string, baseUrl?: string): string {
  const path = `/runs/${runId}`;
  if (baseUrl === undefined || baseUrl.trim() === "") return path;
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

/** Renders the payload as the markdown Slack shows in a channel. */
function renderText(payload: Omit<HandoffDeliveryPayload, "text">): string {
  const lines: string[] = [];
  lines.push(`*Inbound lead handoff — ${payload.company}*`);
  lines.push(
    `Priority ${payload.priorityScore} · fit ${payload.fitAssessment} · GTM ${payload.gtmMotion}`,
  );
  lines.push(`Run \`${payload.runId}\` (${payload.status}) — ${payload.permalink}`);
  lines.push(`Recommended case study: ${payload.recommendedCaseStudyUrl}`);
  if (payload.topFindings.length > 0) {
    lines.push("Top findings:");
    for (const item of payload.topFindings) {
      lines.push(`• ${item.finding} — ${item.sourceUrl}`);
    }
  }
  return lines.join("\n");
}

/**
 * Builds the delivery payload from a run artifact. Pure and exported so the
 * shape can be asserted without any transport involved.
 */
export function buildHandoffPayload(
  artifact: RunArtifact,
  baseUrl?: string,
): HandoffDeliveryPayload {
  const qualification: QualificationResult | undefined = stageOutput(
    artifact.stages.stage1.output,
  );
  const gtm: GtmRecommendation | undefined = stageOutput(artifact.stages.stage5.output);
  const handoff: HandoffSummary | undefined = stageOutput(artifact.stages.stage6.output);

  const topFindings: HandoffFindingPayload[] = (handoff?.topThreeFindings ?? [])
    .slice(0, 3)
    .map((finding) => ({
      finding: finding.finding,
      sourceUrl: finding.sourceUrl,
    }));

  const base: Omit<HandoffDeliveryPayload, "text"> = {
    runId: artifact.runId,
    permalink: runPermalink(artifact.runId, baseUrl),
    status: artifact.status,
    company: artifact.leadProfile.company,
    priorityScore:
      handoff?.qualificationStatus.priorityScore ?? qualification?.priorityScore ?? UNKNOWN,
    fitAssessment:
      handoff?.qualificationStatus.fitAssessment ?? qualification?.fitAssessment ?? UNKNOWN,
    gtmMotion: handoff?.suggestedNextStep.consistentWithMotion ?? gtm?.motion ?? UNKNOWN,
    recommendedCaseStudyUrl: handoff?.recommendedCaseStudy.sourceUrl ?? UNKNOWN,
    topFindings,
  };

  return { ...base, text: renderText(base) };
}

// ---------------------------------------------------------------------------
// deliverHandoff
// ---------------------------------------------------------------------------

/**
 * Best-effort delivery of the AE handoff summary to the configured webhook.
 *
 * @returns `{ delivered: false, channel: "none", reason }` when
 *          `AE_HANDOFF_WEBHOOK_URL` is not configured — this is the normal,
 *          non-error path. Otherwise a webhook POST is attempted and its outcome
 *          is reported. Never throws.
 */
export async function deliverHandoff(
  artifact: RunArtifact,
  opts?: DeliverHandoffOptions,
): Promise<DeliverHandoffResult> {
  let url = opts?.webhookUrl;
  if (url === undefined || url.trim() === "") {
    try {
      url = getAeHandoffWebhookUrl();
    } catch {
      url = undefined;
    }
  }

  if (url === undefined || url.trim() === "") {
    return {
      delivered: false,
      channel: "none",
      reason: "AE_HANDOFF_WEBHOOK_URL not configured",
    };
  }

  const send = opts?.post ?? postJson;

  try {
    const payload = buildHandoffPayload(artifact, opts?.baseUrl);
    const result = await send(url.trim(), payload);
    if (result.ok) return { delivered: true, channel: "webhook" };
    return {
      delivered: false,
      channel: "webhook",
      reason: result.reason ?? "webhook delivery failed",
    };
  } catch (error) {
    // Delivery is a side channel: an unexpected transport error is reported,
    // never propagated to the run.
    return {
      delivered: false,
      channel: "webhook",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
