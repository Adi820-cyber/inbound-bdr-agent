/**
 * Stage 1 — Qualifier (`stage-1-qualifier.ts`), Req 3.1–3.3, 3.5–3.7.
 *
 * No web access. The stage makes exactly ONE schema-constrained LLM call and
 * then does purely deterministic post-processing. Nothing the model returns is
 * trusted blindly:
 *
 *  - The LLM picks exactly one framework from `MEDDPICC | BANT | SPICED` and
 *    justifies it citing `LeadProfile` attributes; the stage rejects a
 *    justification that does not name at least two DISTINCT real lead
 *    attributes (Req 3.1, 3.2).
 *  - `knownFields` are filtered against the actual lead: a field survives only
 *    if its `sourceLeadField` names a lead field whose value is not `"unknown"`
 *    AND its `evidenceQuote` actually appears in the lead's text (Req 3.3).
 *  - Slot coverage is NEVER trusted to the model. `unknownFields` is computed
 *    by `partitionSlots` as `ALL_SLOTS − known`, so the known/unknown split is
 *    an exact partition of the framework's slots by construction (Req 3.4, 3.8).
 *  - `priorityScore` is clamped to an integer in 0..100, `fitAssessment` is
 *    derived from the score bands so the label can never contradict the number,
 *    and `scoreReasoning` is guaranteed to name every scoring factor (Req 3.5,
 *    3.6, 3.7).
 */

import { z } from "zod";
import type {
  FitAssessment,
  KnownField,
  LeadProfile,
  QualificationResult,
  ScoreFactor,
  Stage,
  StageContext,
} from "../contracts";
import { UNKNOWN } from "../contracts";
import {
  knownFieldSchema,
  leadProfileKeySchema,
  qualificationFrameworkSchema,
  qualificationResultSchema,
  scoreFactorSchema,
} from "../schemas";
import { partitionSlots } from "./stage-1/framework-slots";

// ---------------------------------------------------------------------------
// LLM draft schema — the shape the single LLM call is constrained to.
// ---------------------------------------------------------------------------

/**
 * The schema the LLM output is validated against. It carries only the fields
 * the model is allowed to decide: the framework, its justification, the known
 * fields it extracted, and the raw score with its factors. The DERIVED fields
 * (`frameworkSlots`, `unknownFields`, `fitAssessment`) are intentionally absent
 * — the stage computes them deterministically so they cannot be fabricated.
 *
 * `priorityScore` is left unconstrained here (any number) precisely so the
 * clamp step is exercised; the final `QualificationResult` re-validates it as
 * an integer in 0..100.
 */
export const qualificationDraftSchema = z.object({
  framework: qualificationFrameworkSchema,
  frameworkSelectionJustification: z.string(),
  justificationLeadAttributes: z.array(leadProfileKeySchema).min(2),
  knownFields: z.array(knownFieldSchema),
  priorityScore: z.number(),
  scoreFactors: z.array(scoreFactorSchema),
  scoreReasoning: z.string(),
});

export type QualificationDraft = z.infer<typeof qualificationDraftSchema>;

// ---------------------------------------------------------------------------
// Deterministic post-processing helpers (pure, exported for direct testing)
// ---------------------------------------------------------------------------

/** Normalize text for a robust, whitespace/-case-insensitive substring search. */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Build the searchable text corpus of a lead. Every human-readable, known
 * (non-`"unknown"`) attribute plus the raw email subject/body and form fields
 * are concatenated; this is the text an `evidenceQuote` must be found in for a
 * known field to be considered grounded (Req 3.3).
 */
export function buildLeadText(lead: LeadProfile): string {
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== UNKNOWN && value.trim() !== "") {
      parts.push(value);
    } else if (typeof value === "number") {
      parts.push(String(value));
    }
  };

  push(lead.senderName);
  push(lead.senderEmail);
  push(lead.title);
  push(lead.division);
  push(lead.company);
  push(lead.companyDomain);
  push(lead.country);
  push(lead.region);
  push(lead.industry);
  push(lead.statedUseCase);
  push(lead.referralSource);
  push(lead.statedTimeline);
  push(lead.siteCount);
  for (const pain of lead.statedPainPoints) push(pain);

  const email = lead.rawEmail;
  push(email.fromName);
  push(email.fromEmail);
  push(email.subject);
  push(email.body);
  if (email.formFields) {
    for (const value of Object.values(email.formFields)) push(value);
  }

  return parts.join("\n");
}

/**
 * True when the lead field named by `sourceLeadField` carries a real value —
 * i.e. it is not the `"unknown"` marker. Non-string fields (arrays, numbers,
 * the raw email) are never the marker, so they count as known.
 */
export function leadFieldIsKnown(
  lead: LeadProfile,
  field: KnownField["sourceLeadField"],
): boolean {
  return lead[field] !== UNKNOWN;
}

/**
 * True when `quote` (a verbatim span the model claims to have extracted) is
 * actually present in the lead's text. An empty or whitespace-only quote is
 * never grounded.
 */
export function evidenceAppearsInLead(leadText: string, quote: string): boolean {
  const needle = normalizeText(quote);
  if (needle === "") return false;
  return normalizeText(leadText).includes(needle);
}

/**
 * Keep only the known fields that are grounded in the lead (Req 3.3, Property
 * 6): the `sourceLeadField` names a field whose value is not `"unknown"` and
 * the `evidenceQuote` appears in the lead's text content.
 */
export function filterGroundedKnownFields(
  knownFields: readonly KnownField[],
  lead: LeadProfile,
): KnownField[] {
  const leadText = buildLeadText(lead);
  return knownFields.filter(
    (field) =>
      leadFieldIsKnown(lead, field.sourceLeadField) &&
      evidenceAppearsInLead(leadText, field.evidenceQuote),
  );
}

/**
 * The distinct lead attributes cited by a justification, preserving first-seen
 * order. Validation requires at least two of these (Req 3.2, Property 5); the
 * schema enum already guarantees each entry is a real `LeadProfile` key.
 */
export function distinctJustificationAttributes(
  attributes: readonly KnownField["sourceLeadField"][],
): KnownField["sourceLeadField"][] {
  return [...new Set(attributes)];
}

/** Clamp any number to an integer in the closed interval 0..100 (Req 3.5). */
export function clampPriorityScore(score: number): number {
  const finite = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(100, Math.round(finite)));
}

/**
 * Derive the fit assessment from the score bands so the label can never
 * contradict the number (Req 3.7): `>=70` strong, `40..69` moderate, `<40` weak.
 */
export function deriveFitAssessment(priorityScore: number): FitAssessment {
  if (priorityScore >= 70) return "strong_fit";
  if (priorityScore >= 40) return "moderate_fit";
  return "weak_fit";
}

/**
 * Guarantee, by construction, that every scoring factor's name appears in the
 * reasoning (Req 3.6, Property 7). Any factor name missing from the model's
 * reasoning has a deterministic sentence naming it and its signed contribution
 * appended.
 */
export function ensureFactorsNamedInReasoning(
  factors: readonly ScoreFactor[],
  reasoning: string,
): string {
  let text = reasoning;
  const additions: string[] = [];
  for (const factor of factors) {
    if (factor.factor === "") continue;
    if (!text.includes(factor.factor)) {
      const sign = factor.contribution >= 0 ? "+" : "";
      additions.push(`${factor.factor} (${sign}${factor.contribution})`);
    }
  }
  if (additions.length > 0) {
    const prefix = text.trim() === "" ? "" : " ";
    text = `${text}${prefix}Additional contributing factors: ${additions.join("; ")}.`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const STAGE_NAME = "Stage 1 Qualifier";
const SOURCE_FILE = "src/agent/stages/stage-1-qualifier.ts";

function buildSystemPrompt(): string {
  return [
    "You are a B2B sales qualification analyst.",
    "Qualify the inbound lead against exactly ONE framework chosen from:",
    "MEDDPICC, BANT, or SPICED.",
    "",
    "Rules you MUST follow:",
    "- Select exactly one framework and justify the choice by naming at least",
    "  TWO DISTINCT attributes of the lead profile (use the field names).",
    "- Populate knownFields ONLY from information present in the lead. For each",
    "  known field set sourceLeadField to the lead field it came from and set",
    "  evidenceQuote to a verbatim span copied from the lead text. Do NOT invent",
    "  facts; if you are unsure, omit the field.",
    "- Do NOT list unknown slots yourself; the system derives them.",
    "- priorityScore is an integer 0..100. List every scoreFactor with its",
    "  signed point contribution and name each factor in scoreReasoning.",
  ].join("\n");
}

function buildUserPrompt(lead: LeadProfile, validationFeedback?: string): string {
  const leadJson = JSON.stringify(
    {
      senderName: lead.senderName,
      senderEmail: lead.senderEmail,
      title: lead.title,
      division: lead.division,
      company: lead.company,
      companyDomain: lead.companyDomain,
      country: lead.country,
      region: lead.region,
      industry: lead.industry,
      statedUseCase: lead.statedUseCase,
      statedPainPoints: lead.statedPainPoints,
      referralSource: lead.referralSource,
      statedTimeline: lead.statedTimeline,
      siteCount: lead.siteCount,
    },
    null,
    2,
  );

  const sections = [
    "Lead profile (structured attributes):",
    leadJson,
    "",
    "Original inbound email:",
    `Subject: ${lead.rawEmail.subject}`,
    lead.rawEmail.body,
  ];

  if (validationFeedback && validationFeedback.trim() !== "") {
    sections.push("", "Correction required from the previous attempt:", validationFeedback);
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Stage module
// ---------------------------------------------------------------------------

export const stage1Qualifier: Stage<QualificationResult> = {
  stage: 1,
  stageName: STAGE_NAME,
  sourceFile: SOURCE_FILE,
  dependsOn: [],
  usesToolbelt: false,
  schema: qualificationResultSchema,

  async run(ctx: StageContext): Promise<QualificationResult> {
    const lead = ctx.leadProfile;

    // ONE schema-constrained LLM call (Req 3.1). Everything after this point is
    // deterministic post-processing.
    const { value: draft } = await ctx.llm.completeJson({
      purpose: "stage-1-qualification",
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(lead, ctx.validationFeedback),
      schema: qualificationDraftSchema,
      temperature: 0.2,
    });

    // Req 3.2 / Property 5: the justification must name >= 2 DISTINCT real lead
    // attributes. The schema enum guarantees each entry is a real key; here we
    // enforce distinctness and reject (triggering the orchestrator's retry) if
    // fewer than two survive.
    const justificationLeadAttributes = distinctJustificationAttributes(
      draft.justificationLeadAttributes,
    );
    if (justificationLeadAttributes.length < 2) {
      throw new Error(
        "Framework selection justification must reference at least two distinct " +
          "lead attributes.",
      );
    }

    // Req 3.3 / Property 6: keep only known fields grounded in the lead, then
    // dedupe by slot (first grounded field wins per slot).
    const groundedKnownFields = filterGroundedKnownFields(draft.knownFields, lead);
    const knownFieldBySlot = new Map<string, KnownField>();
    for (const field of groundedKnownFields) {
      if (!knownFieldBySlot.has(field.slotId)) {
        knownFieldBySlot.set(field.slotId, field);
      }
    }

    // Req 3.4 / 3.8 / Property 4: slot coverage is an exact partition computed
    // by set difference — never trusted to the model. `partitionSlots` discards
    // slot ids that do not belong to the framework, so `knownSlotIds` is a
    // subset of the map keys.
    const partition = partitionSlots(draft.framework, [...knownFieldBySlot.keys()]);
    const knownFields: KnownField[] = partition.knownSlotIds.map((slotId) => {
      const field = knownFieldBySlot.get(slotId);
      if (!field) {
        // Unreachable: knownSlotIds ⊆ knownFieldBySlot keys by construction.
        throw new Error(`Missing grounded known field for slot ${slotId}.`);
      }
      return field;
    });

    // Req 3.5 / 3.6 / 3.7 / Property 7: clamp the score, derive the band label,
    // and guarantee every factor is named in the reasoning.
    const priorityScore = clampPriorityScore(draft.priorityScore);
    const fitAssessment = deriveFitAssessment(priorityScore);
    const scoreReasoning = ensureFactorsNamedInReasoning(
      draft.scoreFactors,
      draft.scoreReasoning,
    );

    const result: QualificationResult = {
      framework: draft.framework,
      frameworkSlots: partition.frameworkSlots,
      frameworkSelectionJustification: draft.frameworkSelectionJustification,
      justificationLeadAttributes,
      knownFields,
      unknownFields: partition.unknownFields,
      priorityScore,
      scoreFactors: draft.scoreFactors,
      scoreReasoning,
      fitAssessment,
    };

    ctx.emit({
      stage: 1,
      stageName: STAGE_NAME,
      type: "reasoning",
      message:
        `Selected ${result.framework}; priority ${priorityScore} (${fitAssessment}); ` +
        `${knownFields.length} known / ${partition.unknownFields.length} unknown slots.`,
    });

    return result;
  },
};

export default stage1Qualifier;
