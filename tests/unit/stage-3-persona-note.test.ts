/**
 * Unit — Stage 3 persona adaptation note (Req 6.6).
 *
 * Req 6.6 requires the responder to emit a `personaAdaptationNote` that states
 * how tone and technical depth were tuned for the operations-leader persona.
 * Driving the REAL `stage3Responder.run` through a stub LLM, this suite covers
 * both paths that can produce the note:
 *
 *   1. The LLM supplies a note → the sequence surfaces it verbatim (trimmed).
 *   2. The LLM call throws → the stage falls back to a deterministic note that
 *      still describes the tone and technical-depth adjustment for the persona,
 *      so the field is never empty and never invented as evidence.
 */

import { describe, expect, it } from "vitest";

import type {
  LeadProfile,
  QualificationResult,
  ResearchReport,
  ResearchToolbelt,
  StageContext,
} from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";
import { stage3Responder } from "@/agent/stages/stage-3-responder";
import { createStubLlmProvider } from "@tests/support/stub-llm";

/** Stage 3 declares `usesToolbelt: false`; a never-called toolbelt is fine. */
const NOOP_TOOLBELT = {} as unknown as ResearchToolbelt;

const LEAD: LeadProfile = {
  leadId: "lead_ops_1",
  senderName: "Jordan Ops",
  senderEmail: "jordan@example.com",
  title: "VP of Operations",
  division: UNKNOWN,
  company: "Acme Mining",
  companyDomain: UNKNOWN,
  country: UNKNOWN,
  region: UNKNOWN,
  industry: "Mining",
  statedUseCase: UNKNOWN,
  statedPainPoints: [],
  referralSource: UNKNOWN,
  statedTimeline: UNKNOWN,
  siteCount: UNKNOWN,
  rawEmail: {
    fromName: "Jordan Ops",
    fromEmail: "jordan@example.com",
    subject: "Interested in automation",
    body: "We want to automate inspections across our sites.",
  },
  normalizedAt: "2024-01-01T00:00:00.000Z",
};

const QUALIFICATION: QualificationResult = {
  framework: "MEDDPICC",
  frameworkSlots: [],
  frameworkSelectionJustification: "Enterprise deal shape.",
  justificationLeadAttributes: ["title", "industry"],
  knownFields: [],
  unknownFields: [
    { slotId: "economicBuyer", slotLabel: "Economic Buyer", whyItMatters: "Owns the budget." },
    { slotId: "decisionProcess", slotLabel: "Decision Process", whyItMatters: "Steps to a yes." },
    { slotId: "metrics", slotLabel: "Metrics", whyItMatters: "Outcomes to move." },
    { slotId: "timeline", slotLabel: "Timeline", whyItMatters: "When they must act." },
  ],
  priorityScore: 60,
  scoreFactors: [],
  scoreReasoning: "",
  fitAssessment: "moderate_fit",
};

const RESEARCH: ResearchReport = {
  claims: [
    {
      claimId: "claim_budget_1",
      dimension: "budget_signals",
      claimText: "Announced a capital program for site automation.",
      sourceUrl: "https://example.com/news",
      supportingQuote: "investing in automation",
      retrievedAt: "2024-01-01T00:00:00.000Z",
      verificationStatus: "verified",
      numericFigures: [],
    },
  ],
  claimsByDimension: {
    org_structure: [],
    budget_signals: ["claim_budget_1"],
    recent_news: [],
    leadership_language: [],
    positioning: [],
  },
  positioningRecommendation: { narrative: "", assertions: [] },
  dimensionsWithNoSource: [],
  verifiedClaimCount: 1,
};

function makeGeneration(personaAdaptationNote: string) {
  return {
    emails: [
      {
        subject: "Opening the thread",
        body: "First email body.",
        sendTimingGuidance: "Day 0",
        referencedClaimIds: [] as string[],
        progressionRationale: "",
      },
      {
        subject: "Following up",
        body: "Second email body.",
        sendTimingGuidance: "Day 3",
        referencedClaimIds: [] as string[],
        progressionRationale: "Builds on the opener.",
      },
      {
        subject: "Closing the loop",
        body: "Third email body.",
        sendTimingGuidance: "Day 7",
        referencedClaimIds: [] as string[],
        progressionRationale: "Builds on the second email.",
      },
    ],
    personaAdaptationNote,
  };
}

function makeContext(llm: StageContext["llm"]): StageContext {
  return {
    runId: "run_persona_note",
    leadProfile: LEAD,
    toolbelt: NOOP_TOOLBELT,
    llm,
    emit: () => {},
    attempt: 1,
    upstream: { qualification: QUALIFICATION, research: RESEARCH },
  };
}

describe("Stage 3 persona adaptation note (Req 6.6)", () => {
  it("surfaces the LLM-provided note describing tone and technical-depth tuning for the operations-leader persona", async () => {
    const note =
      "Adopted a concise, pragmatic tone and dialed technical depth down to practical outcomes for an operations-leader persona.";
    const llm = createStubLlmProvider({ respondWith: makeGeneration(note) });

    const sequence = await stage3Responder.run(makeContext(llm));

    expect(sequence.personaAdaptationNote).toBe(note);
    expect(sequence.personaAdaptationNote.length).toBeGreaterThan(0);
    expect(sequence.personaAdaptationNote).toMatch(/tone/i);
    expect(sequence.personaAdaptationNote).toMatch(/technical depth/i);
    expect(sequence.personaAdaptationNote).toMatch(/operations[- ]leader/i);
  });

  it("falls back to a deterministic persona note when the LLM call throws", async () => {
    const llm = createStubLlmProvider({
      respondWith: () => {
        throw new Error("llm unavailable");
      },
    });

    const sequence = await stage3Responder.run(makeContext(llm));

    // The note is present, non-empty, and describes the tone and technical-depth
    // adjustment for the operations-leader persona.
    expect(typeof sequence.personaAdaptationNote).toBe("string");
    expect(sequence.personaAdaptationNote.length).toBeGreaterThan(0);
    expect(sequence.personaAdaptationNote).toMatch(/tone/i);
    expect(sequence.personaAdaptationNote).toMatch(/technical depth/i);
    expect(sequence.personaAdaptationNote).toMatch(/operations leader/i);
  });
});
