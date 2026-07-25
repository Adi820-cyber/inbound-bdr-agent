/**
 * Unit tests for `Retry-After` parsing (Task 2.9, Req 17.4).
 *
 * These tests exercise the pure `parseRetryAfter` helper (and its `backoffDelayMs`
 * companion) directly — no adapter, no transport, no network. The injected `now`
 * clock is what makes the HTTP-date form deterministic: the parser computes the
 * delay as `date - now()`, so a fixed clock yields an exact expected delta.
 *
 * Three wire situations are locked down here, matching Req 17.4's rate-limit
 * handling:
 *
 *   1. delay-seconds form (e.g. "120")   → seconds * 1000 ms
 *   2. HTTP-date form (e.g. an RFC 1123 date) → (date - now), floored at 0 ms
 *   3. absent / empty / unparseable value → null, so the caller falls straight
 *      through to `backoffDelayMs` exponential backoff.
 */

import { describe, expect, it } from "vitest";

import { backoffDelayMs, parseRetryAfter } from "@/providers/llm";

// A frozen clock so the HTTP-date delta is exact and reproducible.
const FIXED_NOW_MS = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
const fixedNow = () => FIXED_NOW_MS;

describe("parseRetryAfter — delay-seconds form", () => {
  it("parses a plain integer number of seconds into milliseconds", () => {
    expect(parseRetryAfter("120", fixedNow)).toBe(120_000);
  });

  it("parses zero seconds as zero milliseconds", () => {
    expect(parseRetryAfter("0", fixedNow)).toBe(0);
  });

  it("parses a single second", () => {
    expect(parseRetryAfter("1", fixedNow)).toBe(1_000);
  });

  it("tolerates surrounding whitespace around the seconds value", () => {
    expect(parseRetryAfter("  30  ", fixedNow)).toBe(30_000);
  });
});

describe("parseRetryAfter — HTTP-date form", () => {
  it("returns the delta from now for a future HTTP-date", () => {
    // 90 seconds after the fixed clock.
    const future = new Date(FIXED_NOW_MS + 90_000).toUTCString();
    expect(parseRetryAfter(future, fixedNow)).toBe(90_000);
  });

  it("floors a past HTTP-date at zero rather than returning a negative delay", () => {
    // 60 seconds before the fixed clock — already elapsed.
    const past = new Date(FIXED_NOW_MS - 60_000).toUTCString();
    expect(parseRetryAfter(past, fixedNow)).toBe(0);
  });

  it("returns zero when the HTTP-date equals now", () => {
    const nowDate = new Date(FIXED_NOW_MS).toUTCString();
    expect(parseRetryAfter(nowDate, fixedNow)).toBe(0);
  });

  it("computes the delta relative to the injected clock, not wall-clock time", () => {
    // Drive `now` forward: the same header should yield a smaller delay.
    const target = FIXED_NOW_MS + 120_000;
    const header = new Date(target).toUTCString();
    const laterNow = () => FIXED_NOW_MS + 50_000;
    expect(parseRetryAfter(header, laterNow)).toBe(70_000);
  });
});

describe("parseRetryAfter — absent / unparseable falls through to backoff", () => {
  it("returns null for a null header", () => {
    expect(parseRetryAfter(null, fixedNow)).toBeNull();
  });

  it("returns null for an undefined header", () => {
    expect(parseRetryAfter(undefined, fixedNow)).toBeNull();
  });

  it("returns null for an empty or whitespace-only header", () => {
    expect(parseRetryAfter("", fixedNow)).toBeNull();
    expect(parseRetryAfter("   ", fixedNow)).toBeNull();
  });

  it("returns null for unparseable garbage", () => {
    expect(parseRetryAfter("not-a-date-or-number", fixedNow)).toBeNull();
    expect(parseRetryAfter("soon", fixedNow)).toBeNull();
    expect(parseRetryAfter("later please", fixedNow)).toBeNull();
  });

  it("lets the caller fall through to exponential backoff when the header is absent", () => {
    // This mirrors the caller's `parseRetryAfter(...) ?? backoffDelayMs(idx)`:
    // a null result means the honored delay is unavailable, so backoff applies.
    const honored = parseRetryAfter(null, fixedNow);
    expect(honored).toBeNull();

    const waitMs = honored ?? backoffDelayMs(0);
    expect(waitMs).toBe(backoffDelayMs(0));
    // Backoff is a positive, bounded delay (500ms base at index 0).
    expect(waitMs).toBe(500);
  });

  it("uses the honored delay over backoff when the header IS parseable", () => {
    const honored = parseRetryAfter("2", fixedNow);
    const waitMs = honored ?? backoffDelayMs(0);
    expect(waitMs).toBe(2_000);
  });
});
