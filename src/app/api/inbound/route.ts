/**
 * POST /api/inbound — real inbound email ingestion.
 *
 * This is the endpoint an email provider (SendGrid Inbound Parse, Mailgun
 * Routes, Postmark) or a website contact form posts to. It does four things and
 * nothing else:
 *
 *  1. Authenticates the caller when `INBOUND_WEBHOOK_SECRET` is configured
 *     (`x-webhook-secret` must match). When the variable is unset the endpoint
 *     is intentionally OPEN so the demo can be exercised without setup.
 *  2. Normalizes the payload into a `RawEmailRecord` via the pure
 *     `parseInboundEmail` parser, which accepts provider JSON, an already-shaped
 *     `RawEmailRecord`, form-encoded posts, and raw RFC822 text.
 *  3. Runs the six-stage pipeline to completion. The work is AWAITED: a Node
 *     serverless function may be frozen the moment the response is returned, so
 *     fire-and-forget would silently truncate runs. The response is therefore
 *     slow by design and carries 202 with the run's permalink.
 *  4. Best-effort delivers the Stage 6 handoff to the AE webhook. A delivery
 *     failure is reported in the response body and never fails the request.
 *
 * No secret is ever echoed back: the response carries run facts only.
 */

import { NextRequest, NextResponse } from "next/server";

import type { HandoffSummary, RawEmailRecord } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { deliverHandoff, type DeliverHandoffResult } from "@/agent/handoff-delivery";
import { parseInboundEmail } from "@/agent/inbound-email";
import { runPipeline } from "@/agent/orchestrator";
import { getInboundWebhookSecret } from "@/lib/config/env";

export const runtime = "nodejs";

/** Length-independent comparison so the response time reveals nothing. */
function secretMatches(expected: string, provided: string | null): boolean {
  if (provided === null) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/** Parses the request URL defensively; `null` when it cannot be read. */
function requestUrl(req: NextRequest): URL | null {
  try {
    if (req.nextUrl !== undefined) return req.nextUrl;
    return new URL(req.url);
  } catch {
    return null;
  }
}

/** True when the query param or a body flag asked for a synchronous response. */
function wantsSyncResponse(url: URL | null, record: RawEmailRecord): boolean {
  const param = url?.searchParams.get("mode") ?? null;
  if (param !== null) return param.toLowerCase() === "sync";
  const flag = record.formFields?.mode;
  return typeof flag === "string" && flag.toLowerCase() === "sync";
}

export async function POST(req: NextRequest) {
  // 1. Webhook authentication (open when the secret is not configured).
  let expectedSecret: string | undefined;
  try {
    expectedSecret = getInboundWebhookSecret();
  } catch {
    expectedSecret = undefined;
  }
  if (expectedSecret !== undefined) {
    if (!secretMatches(expectedSecret, req.headers.get("x-webhook-secret"))) {
      return NextResponse.json(
        { error: "Unauthorized: missing or invalid x-webhook-secret header" },
        { status: 401 },
      );
    }
  }

  // 2. Read and normalize the payload. Every supported provider dialect is
  //    handled by the pure parser; `null` means no sender or no body.
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const rawEmail = parseInboundEmail({
    contentType: req.headers.get("content-type"),
    rawBody,
  });

  if (rawEmail === null) {
    return NextResponse.json(
      {
        error:
          "Could not parse an inbound email from this request. Send JSON " +
          '({ from, subject, text } or { rawEmail }), form-encoded fields with the ' +
          "same names, or raw RFC822 text/plain with From:/Subject: headers and a " +
          "body after the first blank line. A sender address and a non-empty body " +
          "are both required.",
      },
      { status: 400 },
    );
  }

  // 3. Run the pipeline to completion. Awaited on purpose (see the file header).
  let artifact;
  try {
    artifact = await runPipeline({ rawEmail, onEvent: () => {} });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `Pipeline failed to run: ${message}` },
      { status: 500 },
    );
  }

  // 4. Best-effort AE handoff delivery. Never fails the response.
  const url = requestUrl(req);
  let delivery: DeliverHandoffResult;
  try {
    delivery = await deliverHandoff(artifact, {
      ...(url === null ? {} : { baseUrl: url.origin }),
    });
  } catch (error) {
    delivery = {
      delivered: false,
      channel: "none",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const handoff: HandoffSummary | typeof UNKNOWN = artifact.stages.stage6.output;

  return NextResponse.json(
    {
      runId: artifact.runId,
      status: artifact.status,
      permalink: `/runs/${artifact.runId}`,
      handoff,
      delivery,
      // Echoed back so a provider integration can confirm what was understood.
      lead: {
        fromEmail: artifact.leadProfile.senderEmail,
        company: artifact.leadProfile.company,
        subject: rawEmail.subject,
      },
      // `sync` is accepted for symmetry with the SSE trigger route; the work is
      // awaited either way, so the flag only documents caller intent.
      mode: wantsSyncResponse(url, rawEmail) ? "sync" : "default",
    },
    { status: 202 },
  );
}
