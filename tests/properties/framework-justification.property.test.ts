/**
 * Property 5 — Framework justification requires two distinct lead attributes.
 *
 * **Validates: Requirements 3.2**
 *
 * The Qualifier lets the LLM pick a framework and cite the lead attributes that
 * justify it, but the stage never trusts that justification blindly. Driving
 * the real `stage1Qualifier.run` through a stub LLM (the single schema-
 * constrained call), this suite asserts:
 *
 *   - An ACCEPTED `QualificationResult` always carries
 *     `justificationLeadAttributes` with at least two entries, all distinct.
 *     A draft that repeats attributes is deduped, and the accepted result holds
 *     the deduped set.
 *   - A draft naming fewer than two DISTINCT attributes (e.g. the same
 *     attribute twice) causes the stage to throw, so the orchestrator retries.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  LeadProfile,
  QualificationFramework,
  ResearchToolbelt,
  StageContext,
} from "@/agent/contracts";
import { stage1Qualifier } from "@/agent/stages/stage-1-qualifier";
import type { QualificationDraft } from "@/agent/stages/stage-1-qualifier";
import { createStubLlmProvider } from "@tests/support/stub-llm";

import { arbLeadProfile } from "./arbitraries";

/** Every `LeadProfile` key — the legal values for a justification attribute. */
const LEAD_KEYS: readonly (keyof LeadProfile)[] = [
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

const arbLeadKey: fc.Arbitrary<keyof LeadProfile> = fc.constantFrom(...LEAD_KEYS);
const arbFramework: fc.Arbitrary<QualificationFramework> = fc.constantFrom(
  "MEDDPICC",
  "BANT",
  "SPICED",
);

/** A minimal valid draft; only the justification attributes vary per test. */
function makeDraft(
  framework: QualificationFramework,
  justificationLeadAttributes: (keyof LeadProfile)[],
): QualificationDraft {
  return {
    framework,
    frameworkSelectionJustification: "Selected on the cited attributes.",
    justificationLeadAttributes,
    knownFields: [],
    priorityScore: 50,
    scoreFactors: [],
    scoreReasoning: "",
  };
}

/** A never-called toolbelt stub; Stage 1 declares `usesToolbelt: false`. */
const NOOP_TOOLBELT = {} as unknown as ResearchToolbelt;

function makeContext(lead: LeadProfile, draft: QualificationDraft): StageContext {
  return {
    runId: "run_prop5",
    leadProfile: lead,
    toolbelt: NOOP_TOOLBELT,
    llm: createStubLlmProvider({ respondWith: draft }),
    emit: () => {},
    attempt: 1,
    upstream: {},
  };
}

describe("Property 5: framework justification requires two distinct lead attributes (Req 3.2)", () => {
  it("an accepted result always names >= 2 distinct lead attributes", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLeadProfile,
        arbFramework,
        fc.uniqueArray(arbLeadKey, { minLength: 2, maxLength: 6 }),
        async (lead, framework, distinctAttrs) => {
          // Repeat the first attribute so the stage must dedupe before checking.
          const withDup = [...distinctAttrs, distinctAttrs[0]!];
          const draft = makeDraft(framework, withDup);

          const result = await stage1Qualifier.run(makeContext(lead, draft));

          const attrs = result.justificationLeadAttributes;
          expect(attrs.length).toBeGreaterThanOrEqual(2);
          // All entries distinct.
          expect(new Set(attrs).size).toBe(attrs.length);
          // Exactly the deduped input set.
          expect(new Set(attrs)).toEqual(new Set(distinctAttrs));
        },
      ),
    );
  });

  it("a draft with fewer than 2 distinct attributes makes the stage throw (retryable)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLeadProfile,
        arbFramework,
        arbLeadKey,
        fc.integer({ min: 2, max: 5 }),
        async (lead, framework, key, count) => {
          // Same attribute repeated: schema-valid (>=2 entries) but only 1 distinct.
          const draft = makeDraft(framework, Array.from({ length: count }, () => key));

          await expect(stage1Qualifier.run(makeContext(lead, draft))).rejects.toThrow();
        },
      ),
    );
  });
});
