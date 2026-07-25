/**
 * Property 20: Case-study serialization round-trips (Req 7.4, 7.5).
 *
 * Feature: inbound-bdr-agent, Property 20: For any case-study record — including
 * records with "unknown" fields, unicode text, embedded newlines, and strings
 * containing the serializer's own delimiter characters — parsing the output of the
 * serializer produces a record structurally equal to the original.
 *
 * `arbCaseStudyRecord` already reaches every called-out edge case: the literal
 * `"unknown"` in each `Maybe<T>` field, empty strings, CJK/emoji unicode,
 * embedded newlines, and delimiter characters (see tests/properties/arbitraries.ts).
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { parseCaseStudy, serializeCaseStudy } from "@/agent/stages/stage-4/case-study-serializer";

import { arbCaseStudyRecord } from "./arbitraries";

describe("case-study serializer round-trip (Property 20)", () => {
  // Validates: Requirements 7.4, 7.5
  test("parseCaseStudy(serializeCaseStudy(record)) deep-equals record for any record", () => {
    fc.assert(
      fc.property(arbCaseStudyRecord, (record) => {
        expect(parseCaseStudy(serializeCaseStudy(record))).toEqual(record);
      }),
      { numRuns: 500 },
    );
  });

  test("serializeCaseStudy is deterministic (equal records serialize identically)", () => {
    fc.assert(
      fc.property(arbCaseStudyRecord, (record) => {
        expect(serializeCaseStudy(record)).toBe(serializeCaseStudy({ ...record }));
      }),
      { numRuns: 200 },
    );
  });
});
