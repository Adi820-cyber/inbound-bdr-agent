/**
 * Unit test — single-framework selection (Task 7.7, Req 3.1).
 *
 * The Qualifier must commit to exactly ONE framework drawn from the closed set
 * `MEDDPICC | BANT | SPICED`. These tests lock that down at the schema boundary
 * — the single source of truth for LLM-output and store validation — so no
 * other framework value can ever enter a `QualificationResult`:
 *
 *   - `qualificationFrameworkSchema` accepts each of the three legal values and
 *     rejects anything else (other names, wrong case, empty string, non-strings).
 *   - `qualificationResultSchema` accepts an otherwise-valid result for each
 *     legal framework and rejects the same result carrying an illegal framework.
 */

import { describe, expect, it } from "vitest";

import type { QualificationResult } from "@/agent/contracts";
import {
  qualificationFrameworkSchema,
  qualificationResultSchema,
} from "@/agent/schemas";

const LEGAL_FRAMEWORKS = ["MEDDPICC", "BANT", "SPICED"] as const;

const ILLEGAL_FRAMEWORKS: readonly unknown[] = [
  "SPIN",
  "CHAMP",
  "GPCT",
  "meddpicc", // wrong case
  "Bant", // wrong case
  "MEDDIC", // near-miss
  "",
  " MEDDPICC",
  "MEDDPICC ",
  "BANT,SPICED",
  null,
  undefined,
  42,
  ["BANT"],
  { framework: "BANT" },
];

/** A valid QualificationResult; only `framework` is swapped per assertion. */
function baseResult(framework: string): QualificationResult {
  return {
    framework: framework as QualificationResult["framework"],
    frameworkSlots: [{ slotId: "budget", slotLabel: "Budget" }],
    frameworkSelectionJustification: "Chosen on the cited attributes.",
    justificationLeadAttributes: ["company", "title"],
    knownFields: [],
    unknownFields: [],
    priorityScore: 55,
    scoreFactors: [],
    scoreReasoning: "",
    fitAssessment: "moderate_fit",
  };
}

describe("single-framework selection (Req 3.1)", () => {
  describe("qualificationFrameworkSchema", () => {
    it("accepts exactly MEDDPICC, BANT, and SPICED", () => {
      for (const framework of LEGAL_FRAMEWORKS) {
        expect(qualificationFrameworkSchema.parse(framework)).toBe(framework);
      }
    });

    it("rejects any other framework value", () => {
      for (const value of ILLEGAL_FRAMEWORKS) {
        expect(qualificationFrameworkSchema.safeParse(value).success).toBe(false);
      }
    });
  });

  describe("qualificationResultSchema", () => {
    it("accepts an otherwise-valid result for each legal framework", () => {
      for (const framework of LEGAL_FRAMEWORKS) {
        const parsed = qualificationResultSchema.safeParse(baseResult(framework));
        expect(parsed.success).toBe(true);
      }
    });

    it("rejects a result carrying an illegal framework value", () => {
      for (const value of ILLEGAL_FRAMEWORKS) {
        if (typeof value !== "string") continue; // framework field is typed string
        const parsed = qualificationResultSchema.safeParse(baseResult(value));
        expect(parsed.success).toBe(false);
      }
    });
  });
});
