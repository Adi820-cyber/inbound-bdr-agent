/**
 * Outbound notification transport (Req 13.4).
 *
 * The AE handoff notification is web egress, and web egress is confined to
 * `src/research/**` and `src/providers/**`. So this module owns the one `fetch`
 * call the handoff delivery needs, and nothing else: no payload shaping, no env
 * reading, no decision about whether to notify. `src/agent/handoff-delivery.ts`
 * builds the payload and calls `postJson`.
 *
 * The transport is total — it never throws. A timeout, a DNS failure, or a
 * non-2xx status all come back as `{ ok: false, ... }` so a failed
 * notification can never fail a run.
 */

import { getConfig } from "@/lib/config/env";

/** Fallback timeout used when the configured value cannot be read. */
const FALLBACK_TIMEOUT_MS = 10_000;

export interface PostJsonResult {
  /** True only on a 2xx response. */
  ok: boolean;
  /** HTTP status code, or `undefined` when the request never got a response. */
  status?: number;
  /** Human-readable failure reason; absent on success. Never contains a secret. */
  reason?: string;
}

function resolveTimeoutMs(): number {
  try {
    return getConfig().requestTimeoutMs;
  } catch {
    // An incomplete environment must not stop a best-effort notification.
    return FALLBACK_TIMEOUT_MS;
  }
}

/**
 * POSTs `payload` as JSON to `url` with the configured request timeout.
 *
 * @returns `{ ok: true, status }` on a 2xx response; otherwise `{ ok: false }`
 *          with a reason. Never throws.
 */
export async function postJson(url: string, payload: unknown): Promise<PostJsonResult> {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    return { ok: false, reason: "payload is not JSON-serializable" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeoutMs());
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: `webhook responded with status ${response.status}`,
      };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
