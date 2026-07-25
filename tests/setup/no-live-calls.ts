/**
 * Test-time network isolation guard (Task 1.5, Req 13.4, 17.4).
 *
 * This file is registered in `vitest.config.ts` via `setupFiles`, so it runs
 * before every test file. It replaces the global `fetch` with a stub that
 * THROWS a clearly-worded error naming the attempted URL. The design's
 * "Mocking Boundaries" rule — "no test touches the network or an LLM" — is thus
 * enforced by code rather than convention: an accidental egress fails loudly
 * instead of silently spending the free-tier quota.
 *
 * The guard is re-armed before AND after every test, so the only way a test can
 * reach the network is to explicitly opt out for the duration of that test by
 * calling `allowLiveNetwork()`. That opt-out is reserved for the gated, opt-in
 * live integration tests (task 20.3), which default to skipped behind their env
 * flag and are the ONLY tests permitted real egress.
 */

import { afterEach, beforeEach } from "vitest";

/** Env flag that gates the opt-in live integration tests (task 20.3). */
export const LIVE_INTEGRATION_ENV_FLAG = "RUN_LIVE_INTEGRATION" as const;

/**
 * True only when the live integration flag is explicitly enabled. Live tests
 * use this to stay skipped by default; a normal `npm test` run never sets it,
 * so no quota is ever spent by the mocked suite.
 */
export function isLiveIntegrationEnabled(): boolean {
  const value = process.env[LIVE_INTEGRATION_ENV_FLAG];
  return value === "1" || value?.toLowerCase() === "true";
}

/** The genuine `fetch`, captured once at module load before the guard is armed. */
const realFetch: typeof globalThis.fetch = globalThis.fetch;

/** Extracts a human-readable URL from any `fetch` input shape for the error. */
function describeTarget(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    // Request-like object.
    if (typeof input === "object" && input !== null && "url" in input) {
      return String((input as Request).url);
    }
  } catch {
    /* fall through to the generic label */
  }
  return "<unknown target>";
}

/**
 * The stub that replaces `fetch`. Any invocation throws immediately, naming the
 * attempted URL so the offending call site is obvious in the failure output.
 */
const guardedFetch = ((input: RequestInfo | URL): never => {
  const target = describeTarget(input);
  throw new Error(
    `[no-live-calls] Blocked a live network fetch to "${target}". ` +
      "Tests must not touch the network or a live model (see the design's " +
      "Mocking Boundaries). Stub the transport via tests/support/stub-llm.ts, " +
      "or, for a gated live integration test, call allowLiveNetwork() first.",
  );
}) as unknown as typeof globalThis.fetch;

/** Arms the guard: every subsequent `fetch` call throws until opted out. */
export function installFetchGuard(): void {
  globalThis.fetch = guardedFetch;
}

/**
 * Opts the CURRENT test out of the guard by restoring the real `fetch`. The
 * guard is automatically re-armed after the test finishes (see `afterEach`),
 * so the opt-out never leaks into another test. Reserved for the opt-in live
 * integration tests (task 20.3).
 */
export function allowLiveNetwork(): void {
  globalThis.fetch = realFetch;
}

/** Returns the genuine `fetch` captured before the guard was armed. */
export function getRealFetch(): typeof globalThis.fetch {
  return realFetch;
}

// Arm immediately at setup time, then re-arm around every test so that any
// per-test opt-out is scoped to exactly that test.
installFetchGuard();
beforeEach(() => {
  installFetchGuard();
});
afterEach(() => {
  installFetchGuard();
});
