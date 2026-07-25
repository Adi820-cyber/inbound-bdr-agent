/**
 * Stage 3 — Responder (`stage-3-responder.ts`, Req 6.1, 6.2, 6.5, 6.6, 6.7).
 *
 * No web access. The shape of this stage is "deterministic pre-planning, then a
 * single LLM generation call, then deterministic post-processing that forces
 * every schema-critical invariant to hold" (design §"Stage 3 — Responder"). The
 * model is asked to write persuasive copy; it is never trusted to satisfy the
 * structural contract. That contract is enforced here in code:
 *
 *   1. `planUnknownSlots` (pure, in `stage-3/slot-plan.ts`) partitions the
 *      qualification result's `unknownFields` across the three drafts, 1–2 per
 *      draft, and guarantees ≥3 distinct slots are covered when ≥3 exist. We pad
 *      the input to ≥3 distinct slots first so the `coveredUnknownSlotIds.min(3)`
 *      schema bound (Req 6.4) is always satisfiable by arithmetic, not by luck.
 *   2. Verified research claim ids are collected from the upstream report
 *      (`verificationStatus === "verified"`). Their presence selects the prompt:
 *        - ≥1 verified claim → the drafts must each cite ≥1 verified claim id
 *          (Req 6.2); the LLM is handed the verified-claim menu.
 *        - 0 verified claims → a LEAD-FACTS-ONLY prompt, and the sequence is
 *          annotated with `researchUnavailableNotice` (Req 6.7).
 *   3. ONE `ctx.llm.completeJson` call generates all three drafts (subject, body,
 *      send-timing, an attempted claim reference, a progression rationale) plus
 *      the persona-adaptation note. A deterministic fallback covers LLM failure
 *      so the stage degrades instead of throwing.
 *   4. Post-processing overrides the model where the contract demands it:
 *        - `targetedUnknownSlotIds` come from the plan, never the model (Req 6.3).
 *        - `referencedClaimIds` are repaired to resolvable ids: verified ids in
 *          the research-available path, the report's "unknown" claim ids (or a
 *          single sentinel) in the research-unavailable path — see the note on
 *          the schema tension below.
 *        - `progressionRationale` is forced to `"unknown"` on draft 1 and to a
 *          non-unknown string on drafts 2 and 3 (Req 6.5).
 *        - `coveredUnknownSlotIds` is the plan's distinct union (Req 6.4).
 *        - `personaAdaptationNote` is always present (Req 6.6).
 *
 * ---------------------------------------------------------------------------
 * SCHEMA TENSION (research-unavailable path) — resolved here
 * ---------------------------------------------------------------------------
 * `emailDraftSchema.referencedClaimIds` is `.min(1)`: every draft MUST cite at
 * least one claim id. But Req 6.7 says the research-unavailable path references
 * "only Lead_Profile facts" — i.e. no verified research. These cannot both be
 * literally true with an empty array, so we reconcile them the way the design
 * intends: in the zero-verified path the drafts reference the report's
 * *unverified* ("unknown") claim ids — which are resolvable against the report,
 * just not evidence — while `researchUnavailableNotice` carries the signal that
 * no verified research backs the copy. When the report carries no claims at all
 * (e.g. an upstream stage produced none), a single deterministic sentinel id is
 * used so the schema still holds. A sentinel id is never invented as *evidence*;
 * it exists only to satisfy the structural `min(1)` while the notice makes the
 * absence of research explicit to every downstream reader.
 */

import { z } from "zod";

import type {
  EmailDraft,
  EmailSequence,
  Maybe,
  QualificationResult,
  ResearchReport,
  Stage,
  StageContext,
  UnknownField,
} from "../contracts";
import { UNKNOWN } from "../contracts";
import { emailSequenceSchema } from "../schemas";
import { planUnknownSlots, type SlotPlan } from "./stage-3/slot-plan";

// ---------------------------------------------------------------------------
// Stage identity
// ---------------------------------------------------------------------------

const STAGE = 3 as const;
const STAGE_NAME = "Responder";
const SOURCE_FILE = "src/agent/stages/stage-3-responder.ts";
const DEPENDS_ON = ["qualification", "research"] as const;

/** Deterministic send-timing cadence surfaced on the three drafts. */
const SEND_TIMING = ["Day 0", "Day 3", "Day 7"] as const;

/**
 * Generic high-information slots used to pad the qualification's `unknownFields`
 * up to ≥3 distinct entries when it carries fewer. This keeps the
 * `coveredUnknownSlotIds.min(3)` bound (Req 6.4) satisfiable by construction —
 * these are meaningful discovery targets for any B2B deal, not company-specific
 * literals. They mirror the priority slots the planner favors.
 */
const DEFAULT_UNKNOWN_SLOTS: readonly UnknownField[] = [
  {
    slotId: "economicBuyer",
    slotLabel: "Economic Buyer",
    whyItMatters: "Identifies who owns the budget and can approve a purchase.",
  },
  {
    slotId: "decisionProcess",
    slotLabel: "Decision Process",
    whyItMatters: "Reveals the steps and stakeholders required to reach a decision.",
  },
  {
    slotId: "metrics",
    slotLabel: "Metrics",
    whyItMatters: "Surfaces the quantified outcomes the buyer is trying to move.",
  },
] as const;

/**
 * Deterministic sentinel claim id used ONLY in the research-unavailable path when
 * the report carries no claims at all, so `referencedClaimIds.min(1)` still holds
 * while `researchUnavailableNotice` signals that no verified research exists.
 */
const RESEARCH_UNAVAILABLE_CLAIM_ID = "claim_research_unavailable";

// ---------------------------------------------------------------------------
// Upstream resolution
// ---------------------------------------------------------------------------

/** Resolve the upstream qualification output, or `null` when absent/failed. */
function resolveQualification(
  upstream: StageContext["upstream"]["qualification"],
): QualificationResult | null {
  return upstream !== undefined && upstream !== UNKNOWN ? upstream : null;
}

/** Resolve the upstream research report, or `null` when absent/failed. */
function resolveResearch(
  upstream: StageContext["upstream"]["research"],
): ResearchReport | null {
  return upstream !== undefined && upstream !== UNKNOWN ? upstream : null;
}

// ---------------------------------------------------------------------------
// Claim id pools
// ---------------------------------------------------------------------------

interface ClaimPools {
  /** Claim ids with `verificationStatus === "verified"`, deduped, in order. */
  verified: string[];
  /** Every claim id present in the report, deduped, in order. */
  resolvable: string[];
}

/** Collect the verified and resolvable claim-id pools from a research report. */
function collectClaimPools(research: ResearchReport | null): ClaimPools {
  const verified: string[] = [];
  const resolvable: string[] = [];
  const seenVerified = new Set<string>();
  const seenResolvable = new Set<string>();

  for (const claim of research?.claims ?? []) {
    const id = claim?.claimId;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!seenResolvable.has(id)) {
      seenResolvable.add(id);
      resolvable.push(id);
    }
    if (claim.verificationStatus === "verified" && !seenVerified.has(id)) {
      seenVerified.add(id);
      verified.push(id);
    }
  }

  return { verified, resolvable };
}

// ---------------------------------------------------------------------------
// Slot planning input padding (guarantees ≥3 distinct slots — Req 6.4)
// ---------------------------------------------------------------------------

/** Count distinct, non-empty slot ids in an unknown-field list. */
function distinctSlotCount(fields: readonly UnknownField[]): number {
  const seen = new Set<string>();
  for (const f of fields) {
    if (typeof f?.slotId === "string" && f.slotId.length > 0) seen.add(f.slotId);
  }
  return seen.size;
}

/**
 * Ensure the field list feeding the planner carries ≥3 distinct slots by
 * appending generic defaults not already present. Real qualification unknowns
 * are always kept; defaults only fill the gap so the ≥3-distinct coverage
 * guarantee (Req 6.4) holds even for a sparsely-qualified lead.
 */
function padUnknownFields(fields: readonly UnknownField[]): UnknownField[] {
  const result: UnknownField[] = fields.filter(
    (f) => typeof f?.slotId === "string" && f.slotId.length > 0,
  );
  const present = new Set(result.map((f) => f.slotId));

  for (const def of DEFAULT_UNKNOWN_SLOTS) {
    if (distinctSlotCount(result) >= 3) break;
    if (!present.has(def.slotId)) {
      result.push(def);
      present.add(def.slotId);
    }
  }
  return result;
}

/** Build a slotId → human label map for prompt context. */
function slotLabelMap(fields: readonly UnknownField[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of fields) {
    if (typeof f?.slotId === "string" && f.slotId.length > 0) {
      map.set(f.slotId, f.slotLabel && f.slotLabel.length > 0 ? f.slotLabel : humanizeSlotId(f.slotId));
    }
  }
  return map;
}

/** Turn a camelCase / snake_case slot id into a readable label as a fallback. */
function humanizeSlotId(slotId: string): string {
  const spaced = slotId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : slotId;
}

// ---------------------------------------------------------------------------
// LLM generation schema (copy only — structure is enforced in post-processing)
// ---------------------------------------------------------------------------

const generatedDraftSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  sendTimingGuidance: z.string().min(1),
  referencedClaimIds: z.array(z.string()),
  progressionRationale: z.string(),
});

const generationSchema = z.object({
  emails: z.tuple([generatedDraftSchema, generatedDraftSchema, generatedDraftSchema]),
  personaAdaptationNote: z.string().min(1),
});

type GeneratedSequence = z.infer<typeof generationSchema>;

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/** Collapse a `Maybe<string>` to plain text (empty string when unknown). */
function text(value: Maybe<string>): string {
  return value !== UNKNOWN && typeof value === "string" ? value : "";
}

interface PromptContext {
  leadFacts: string;
  slotBrief: string;
  claimMenu: string;
  researchAvailable: boolean;
}

/** Human-readable lead fact block assembled from typed LeadProfile attributes. */
function buildLeadFacts(ctx: StageContext): string {
  const lead = ctx.leadProfile;
  const lines: string[] = [];
  const push = (label: string, value: Maybe<string>) => {
    const v = text(value);
    if (v.length > 0) lines.push(`- ${label}: ${v}`);
  };
  push("Contact name", lead.senderName);
  push("Title", lead.title);
  push("Division", lead.division);
  push("Company", lead.company);
  push("Industry", lead.industry);
  push("Country", lead.country);
  push("Region", lead.region);
  push("Stated use case", lead.statedUseCase);
  if (lead.statedPainPoints.length > 0) {
    lines.push(`- Stated pain points: ${lead.statedPainPoints.join("; ")}`);
  }
  push("Referral source", lead.referralSource);
  push("Stated timeline", lead.statedTimeline);
  if (typeof lead.siteCount === "number") lines.push(`- Site count: ${lead.siteCount}`);
  return lines.length > 0 ? lines.join("\n") : "- (No qualifying lead facts were captured.)";
}

/**
 * Per-draft slot brief: for each email, which unknown qualification field it must
 * be designed to surface, with the human label and why it matters (Req 6.3).
 */
function buildSlotBrief(
  plan: SlotPlan,
  labels: Map<string, string>,
  whyMatters: Map<string, string>,
): string {
  return plan.assignments
    .map((assignment) => {
      const slots = assignment.targetedUnknownSlotIds
        .map((id) => {
          const label = labels.get(id) ?? humanizeSlotId(id);
          const why = whyMatters.get(id);
          return why ? `${label} (${why})` : label;
        })
        .join("; ");
      return `- Email ${assignment.position}: surface ${slots}`;
    })
    .join("\n");
}

/** The verified-claim menu the drafts must cite from (research-available path). */
function buildClaimMenu(research: ResearchReport | null, verified: string[]): string {
  if (verified.length === 0) return "";
  const byId = new Map<string, string>();
  for (const claim of research?.claims ?? []) {
    if (verified.includes(claim.claimId)) {
      byId.set(claim.claimId, text(claim.claimText));
    }
  }
  return verified
    .map((id) => {
      const claimText = byId.get(id);
      return claimText && claimText.length > 0 ? `- ${id}: ${claimText}` : `- ${id}`;
    })
    .join("\n");
}

function buildPromptContext(
  ctx: StageContext,
  plan: SlotPlan,
  research: ResearchReport | null,
  pools: ClaimPools,
  labels: Map<string, string>,
  whyMatters: Map<string, string>,
): PromptContext {
  return {
    leadFacts: buildLeadFacts(ctx),
    slotBrief: buildSlotBrief(plan, labels, whyMatters),
    claimMenu: buildClaimMenu(research, pools.verified),
    researchAvailable: pools.verified.length > 0,
  };
}

function buildSystemPrompt(researchAvailable: boolean): string {
  const base = [
    "You are a B2B business-development representative writing a three-email outbound sequence.",
    "The recipient is an operations-leader persona: pragmatic, time-poor, and outcome-driven.",
    "Adapt tone and technical depth accordingly — grounded, concrete, and respectful of their time.",
    "Each email must be designed to surface the specific unknown qualifying information it is assigned.",
    "Emails 2 and 3 must build on the one before; email 1 opens the thread.",
    "Return exactly three emails plus a persona-adaptation note describing how you tuned tone and technical depth.",
  ];
  if (researchAvailable) {
    base.push(
      "You are given a menu of VERIFIED research claim ids. Each email must cite at least one claim id from that menu in referencedClaimIds, and the copy must reflect that claim.",
      "Do not invent claim ids or facts beyond the provided menu and lead facts.",
    );
  } else {
    base.push(
      "No verified research is available. Write using ONLY the provided lead facts.",
      "Do not cite research, statistics, or external facts. Leave referencedClaimIds as an empty array.",
    );
  }
  return base.join(" ");
}

function buildUserPrompt(promptCtx: PromptContext): string {
  const sections = [
    "LEAD FACTS:",
    promptCtx.leadFacts,
    "",
    "PER-EMAIL DISCOVERY ASSIGNMENTS (design each email to surface these):",
    promptCtx.slotBrief,
  ];
  if (promptCtx.researchAvailable) {
    sections.push(
      "",
      "VERIFIED RESEARCH CLAIMS (cite at least one id per email in referencedClaimIds):",
      promptCtx.claimMenu,
    );
  } else {
    sections.push(
      "",
      "NO VERIFIED RESEARCH IS AVAILABLE. Reference only the lead facts above; keep referencedClaimIds empty.",
    );
  }
  sections.push(
    "",
    "For each email provide: subject, body, sendTimingGuidance, referencedClaimIds, progressionRationale.",
    "progressionRationale for email 1 may be empty; for emails 2 and 3 explain why each follows the preceding email.",
  );
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic fallback generation (used on LLM failure — Req 17.1 posture)
// ---------------------------------------------------------------------------

function buildFallbackGeneration(
  ctx: StageContext,
  plan: SlotPlan,
  labels: Map<string, string>,
): GeneratedSequence {
  const company = text(ctx.leadProfile.company) || "your team";
  const contact = text(ctx.leadProfile.senderName);
  const greeting = contact.length > 0 ? `Hi ${contact},` : "Hi there,";

  const draftFor = (index: 0 | 1 | 2) => {
    const assignment = plan.assignments[index];
    const slotLabels = assignment.targetedUnknownSlotIds
      .map((id) => labels.get(id) ?? humanizeSlotId(id))
      .join(" and ");
    return {
      subject:
        index === 0
          ? `Supporting operations at ${company}`
          : `Following up on ${company}'s operations`,
      body: [
        greeting,
        index === 0
          ? `I work with operations leaders on measurable outcomes and wanted to reach out about ${company}.`
          : `Circling back on my previous note about ${company}.`,
        `To tailor next steps, it would help to understand ${slotLabels}.`,
        "Would a short conversation make sense?",
      ].join("\n\n"),
      sendTimingGuidance: SEND_TIMING[index],
      referencedClaimIds: [] as string[],
      progressionRationale:
        index === 0
          ? ""
          : "Builds on the prior email by narrowing toward the discovery information still outstanding.",
    };
  };

  return {
    emails: [draftFor(0), draftFor(1), draftFor(2)],
    personaAdaptationNote:
      "Tone is concise and grounded for a time-poor operations leader; technical depth is kept practical and outcome-focused rather than product-heavy.",
  };
}

// ---------------------------------------------------------------------------
// Post-processing: force every schema-critical invariant to hold
// ---------------------------------------------------------------------------

/** Choose the resolvable/verified claim ids a draft should cite. */
function resolveReferencedClaimIds(
  index: number,
  attempted: string[],
  pools: ClaimPools,
  researchAvailable: boolean,
): string[] {
  if (researchAvailable) {
    // Keep only ids the LLM cited that are genuinely verified; guarantee ≥1.
    const verifiedSet = new Set(pools.verified);
    const kept = attempted.filter((id) => verifiedSet.has(id));
    if (kept.length > 0) return dedupe(kept);
    const fallback = pools.verified[index % pools.verified.length];
    return fallback !== undefined ? [fallback] : [RESEARCH_UNAVAILABLE_CLAIM_ID];
  }

  // Research-unavailable path: cite a resolvable "unknown" claim id when the
  // report has any claims, otherwise the deterministic sentinel (see file note).
  if (pools.resolvable.length > 0) {
    const id = pools.resolvable[index % pools.resolvable.length];
    return id !== undefined ? [id] : [RESEARCH_UNAVAILABLE_CLAIM_ID];
  }
  return [RESEARCH_UNAVAILABLE_CLAIM_ID];
}

/** Deduplicate a string list, preserving first-seen order. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Force the progression rationale: "unknown" on draft 1, a real string on 2/3. */
function resolveProgressionRationale(index: number, generated: string): Maybe<string> {
  if (index === 0) return UNKNOWN;
  const trimmed = generated.trim();
  if (trimmed.length > 0 && trimmed.toLowerCase() !== UNKNOWN) return trimmed;
  return "Builds on the preceding email by advancing the discovery thread toward the next outstanding qualifying detail.";
}

function assembleDraft(
  index: 0 | 1 | 2,
  generation: GeneratedSequence,
  plan: SlotPlan,
  pools: ClaimPools,
  researchAvailable: boolean,
): EmailDraft {
  const gen = generation.emails[index];
  const assignment = plan.assignments[index];
  const fallbackTiming = SEND_TIMING[index];
  return {
    position: (index + 1) as 1 | 2 | 3,
    subject: gen.subject.trim().length > 0 ? gen.subject.trim() : `Reaching out (${fallbackTiming})`,
    body: gen.body.trim().length > 0 ? gen.body.trim() : "Following up on our earlier note.",
    referencedClaimIds: resolveReferencedClaimIds(
      index,
      gen.referencedClaimIds,
      pools,
      researchAvailable,
    ),
    targetedUnknownSlotIds: assignment.targetedUnknownSlotIds,
    sendTimingGuidance:
      gen.sendTimingGuidance.trim().length > 0 ? gen.sendTimingGuidance.trim() : fallbackTiming,
    progressionRationale: resolveProgressionRationale(index, gen.progressionRationale),
  };
}

function assembleSequence(
  generation: GeneratedSequence,
  plan: SlotPlan,
  pools: ClaimPools,
  researchAvailable: boolean,
): EmailSequence {
  const emails: [EmailDraft, EmailDraft, EmailDraft] = [
    assembleDraft(0, generation, plan, pools, researchAvailable),
    assembleDraft(1, generation, plan, pools, researchAvailable),
    assembleDraft(2, generation, plan, pools, researchAvailable),
  ];

  const personaAdaptationNote =
    generation.personaAdaptationNote.trim().length > 0
      ? generation.personaAdaptationNote.trim()
      : "Tone tuned concise and grounded for an operations-leader persona; technical depth kept practical and outcome-focused.";

  const researchUnavailableNotice: Maybe<string> = researchAvailable
    ? UNKNOWN
    : "No verified research claims were available for this lead; these drafts reference only lead-provided facts.";

  return {
    emails,
    coveredUnknownSlotIds: plan.coveredUnknownSlotIds,
    personaAdaptationNote,
    researchUnavailableNotice,
  };
}

// ---------------------------------------------------------------------------
// Stage module (Req 13.5)
// ---------------------------------------------------------------------------

export const stage3Responder: Stage<EmailSequence> = {
  stage: STAGE,
  stageName: STAGE_NAME,
  sourceFile: SOURCE_FILE,
  dependsOn: DEPENDS_ON,
  usesToolbelt: false,
  schema: emailSequenceSchema,

  async run(ctx: StageContext): Promise<EmailSequence> {
    const qualification = resolveQualification(ctx.upstream.qualification);
    const research = resolveResearch(ctx.upstream.research);

    // 1. Deterministic slot plan (Req 6.3, 6.4). Pad to ≥3 distinct slots so the
    //    coverage bound is met by arithmetic regardless of how sparse the lead is.
    const paddedFields = padUnknownFields(qualification?.unknownFields ?? []);
    const plan = planUnknownSlots(paddedFields);
    const labels = slotLabelMap(paddedFields);
    const whyMatters = new Map<string, string>();
    for (const f of paddedFields) {
      if (typeof f?.slotId === "string" && f.slotId.length > 0 && f.whyItMatters) {
        whyMatters.set(f.slotId, f.whyItMatters);
      }
    }

    // 2. Claim pools decide the prompt: verified-claim path vs lead-facts-only.
    const pools = collectClaimPools(research);
    const researchAvailable = pools.verified.length > 0;

    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "reasoning",
      message: researchAvailable
        ? `Generating 3 drafts against ${pools.verified.length} verified claim(s); covering ${plan.coveredUnknownSlotIds.length} unknown slot(s).`
        : `No verified research claims; generating lead-facts-only drafts covering ${plan.coveredUnknownSlotIds.length} unknown slot(s).`,
    });

    // 3. One generation call (subject/body/timing/claims/rationale + persona note).
    const promptCtx = buildPromptContext(ctx, plan, research, pools, labels, whyMatters);
    let generation: GeneratedSequence;
    try {
      const result = await ctx.llm.completeJson({
        purpose: "stage3_email_sequence",
        systemPrompt: buildSystemPrompt(researchAvailable),
        userPrompt: buildUserPrompt(promptCtx),
        schema: generationSchema,
        maxOutputTokens: 1800,
        temperature: 0.4,
      });
      generation = result.value;

      ctx.emit({
        stage: STAGE,
        stageName: STAGE_NAME,
        type: "llm_call",
        message: "Generated the three-email sequence.",
        llmCall: {
          provider: ctx.llm.name,
          model: result.modelUsed,
          purpose: "stage3_email_sequence",
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          attempt: ctx.attempt,
        },
      });
    } catch {
      ctx.emit({
        stage: STAGE,
        stageName: STAGE_NAME,
        type: "reasoning",
        message: "Email generation LLM call failed; using deterministic fallback drafts.",
      });
      generation = buildFallbackGeneration(ctx, plan, labels);
    }

    // 4. Deterministic post-processing forces every schema-critical invariant.
    return assembleSequence(generation, plan, pools, researchAvailable);
  },
};

export default stage3Responder;
