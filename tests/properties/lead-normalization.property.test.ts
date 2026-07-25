/**
 * Property 1 — Lead normalization is total and lossless.
 *
 * **Validates: Requirements 1.3, 1.4**
 *
 * `normalizeLead(rawEmail, now?)` turns any `RawEmailRecord` into a fully
 * populated `LeadProfile`. This suite asserts the two halves of that contract
 * across arbitrary inputs (via `arbRawEmail`, which folds in the called-out
 * edge cases: `"unknown"`, empty strings, unicode, embedded delimiters, very
 * long strings):
 *
 *   1. TOTAL — every `LeadProfile` field is defined (never `undefined`); every
 *      `Maybe` field is either a real value or exactly `"unknown"`; and the
 *      whole result validates against `leadProfileSchema`. `normalizedAt` is a
 *      valid ISO-8601 timestamp and `statedPainPoints` is an array.
 *   2. LOSSLESS — `result.rawEmail` deep-equals the input `rawEmail`, so the
 *      original record is preserved verbatim for the audit trail.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { LeadProfile } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { normalizeLead } from "@/agent/lead-normalizer";
import { leadProfileSchema } from "@/agent/schemas";

import { arbRawEmail } from "./arbitraries";

/** Every field name on a `LeadProfile`. */
const LEAD_PROFILE_KEYS: readonly (keyof LeadProfile)[] = [
  "leadId",
  "senderName",
  "senderEmail",
  "title",
  "division",
  "company",
  "companyDomain",
  "country",
  "region",
  "industry",
  "statedUseCase",
  "statedPainPoints",
  "referralSource",
  "statedTimeline",
  "siteCount",
  "rawEmail",
  "normalizedAt",
];

/** `Maybe<string>` fields — each must be a string (a real value or `"unknown"`). */
const MAYBE_STRING_KEYS: readonly (keyof LeadProfile)[] = [
  "senderName",
  "senderEmail",
  "title",
  "division",
  "company",
  "companyDomain",
  "country",
  "region",
  "industry",
  "statedUseCase",
  "referralSource",
  "statedTimeline",
];

/** An injectable, deterministic clock for reproducible `normalizedAt` values. */
const FIXED_NOW = "2024-01-15T12:00:00.000Z";
const fixedClock = () => FIXED_NOW;

describe("Property 1: lead normalization is total and lossless (Req 1.3, 1.4)", () => {
  it("is TOTAL — no field is undefined for any raw email", () => {
    fc.assert(
      fc.property(arbRawEmail, (rawEmail) => {
        const profile = normalizeLead(rawEmail, fixedClock);
        for (const key of LEAD_PROFILE_KEYS) {
          expect(profile[key]).toBeDefined();
          expect(profile[key]).not.toBeUndefined();
        }
      }),
    );
  });

  it("TOTAL — every Maybe field is a real value or exactly \"unknown\"", () => {
    fc.assert(
      fc.property(arbRawEmail, (rawEmail) => {
        const profile = normalizeLead(rawEmail, fixedClock);

        // Maybe<string> fields: always a string (which includes "unknown").
        for (const key of MAYBE_STRING_KEYS) {
          expect(typeof profile[key]).toBe("string");
        }

        // Maybe<number> field: either a real number or exactly "unknown".
        const isNumber = typeof profile.siteCount === "number";
        const isUnknown = profile.siteCount === UNKNOWN;
        expect(isNumber || isUnknown).toBe(true);
      }),
    );
  });

  it("TOTAL — the result validates against leadProfileSchema", () => {
    fc.assert(
      fc.property(arbRawEmail, (rawEmail) => {
        const profile = normalizeLead(rawEmail, fixedClock);
        const parsed = leadProfileSchema.safeParse(profile);
        expect(parsed.success).toBe(true);
      }),
    );
  });

  it("TOTAL — normalizedAt is a valid ISO-8601 timestamp", () => {
    fc.assert(
      fc.property(arbRawEmail, (rawEmail) => {
        // Use the real default clock here so we exercise the production path.
        const profile = normalizeLead(rawEmail);
        expect(typeof profile.normalizedAt).toBe("string");
        const asDate = new Date(profile.normalizedAt);
        expect(Number.isNaN(asDate.getTime())).toBe(false);
        // Round-trips through Date without loss => it is a canonical ISO string.
        expect(asDate.toISOString()).toBe(profile.normalizedAt);
      }),
    );
  });

  it("TOTAL — statedPainPoints is always an array", () => {
    fc.assert(
      fc.property(arbRawEmail, (rawEmail) => {
        const profile = normalizeLead(rawEmail, fixedClock);
        expect(Array.isArray(profile.statedPainPoints)).toBe(true);
      }),
    );
  });

  it("is LOSSLESS — result.rawEmail deep-equals the input verbatim", () => {
    fc.assert(
      fc.property(arbRawEmail, (rawEmail) => {
        const before = structuredClone(rawEmail);
        const profile = normalizeLead(rawEmail, fixedClock);

        // The preserved copy equals what arrived, and the input is unmutated.
        expect(profile.rawEmail).toEqual(rawEmail);
        expect(profile.rawEmail).toEqual(before);
      }),
    );
  });
});
