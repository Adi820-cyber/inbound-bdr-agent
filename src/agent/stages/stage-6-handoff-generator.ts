/**
 * Stage 6 — Handoff Generator (`stage-6-handoff-generator.ts`, Req 10.1-10.7).
 *
 * This stage produces the single scannable `HandoffSummary` an AE reads to act
 * within two minutes. It is a *pure derivation* over the outputs of stages 1
 * through 5 — it adds no new facts, issues no toolbelt calls, and cites no URL
 * that did not already appear in an upstream output (Req 10.6). Because of that
 * contract every structural value is computed deterministically from the
 * upstream outputs:
 *
 *   - Qualification status (framework, priority score, fit, known-field count,
 *     unknown slot labels) is reproduced verbatim from the Stage 1 output
 *     (Req 10.2).
 *   - The top-three findings are selected deterministically from the Stage 2
 *     verified claims — ranked by dimension priority, then by numeric-figure
 *     presence — and every entry carries its own source URL. When fewer than
 *     three verified claims exist, the remaining entries are filled with the
 *     `"unknown"` marker and `verifiedFindingsAvailable` records how many were
 *     actually available (Req 10.3, 10.7).
 *   - The recommended case study is copied from the Stage 4 winner, with its
 *     "why it won" text taken from the Stage 4 comparison statement / deciding
 *     dimensions (Req 10.4).
 *   - The suggested next step is templated on the Stage 5 GTM motion, and
 *     `consistentWithMotion` is set to that exact motion (Req 10.5).
 *
 * ONE optional LLM call composes the human-readable prose (the buyer-context
 * paragraph and the next-step action/rationale wording) from the already-derived
 * structured facts. The call can never introduce a new fact, a new URL, or a
 * different motion: those come from the deterministic values above. On any LLM
 * failure the stage falls back to a deterministic narrative, so it degrades
 * instead of throwing (Req 17.1).
 */

import { z } from "zod";

import type {
  GtmMotion,
  GtmRecommendation,
  HandoffFinding,
  HandoffSummary,
  MatchResult,
  Maybe,
  QualificationResult,
  ResearchClaim,
  ResearchDimension,
  ResearchReport,
  ScoredCaseStudy,
  Stage,
  StageContext,
} from "../contracts";
import { UNKNOWN } from "../contracts";
import { handoffSummarySchema } from "../schemas";

// ---------------------------------------------------------------------------
// Stage identity
// ---------------------------------------------------------------------------

const STAGE = 6 as const;
const STAGE_NAME = "Handoff Generator";
const SOURCE_FILE = "src/agent/stages/stage-6-handoff-generator.ts";
const DEPENDS_ON = ["qualification", "research", "emails", "match", "gtm"] as const;

/**
 * Deterministic ranking priority for research dimensions when selecting the top
 * three findings. Lower number ranks higher. Buying signals and org structure
 * are the most actionable for an AE, followed by recent news, leadership
 * language, and finally the synthesized positioning dimension.
 */
const DIMENSION_PRIORITY: Record<ResearchDimension, number> = {
  budget_signals: 0,
  org_structure: 1,
  recent_news: 2,
  leadership_language: 3,
  positioning: 4,
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** True when a `Maybe<string>` carries a usable value. */
function isKnownString(value: Maybe<string>): value is string {
  return value !== UNKNOWN && typeof value === "string" && value.trim().length > 0;
}

/** Collapse a `Maybe<string>` to plain text (empty string when unknown). */
function text(value: Maybe<string>): string {
  return isKnownString(value) ? value : "";
}

/** Resolve an upstream output, treating `"unknown"`/`undefined` as absent. */
function resolveUpstream<T>(value: T | typeof UNKNOWN | undefined): T | null {
  return value !== undefined && value !== UNKNOWN ? (value as T) : null;
}

// ---------------------------------------------------------------------------
// Section builders (all deterministic — the structural spine of the summary)
// ---------------------------------------------------------------------------

/**
 * Reproduce the Stage 1 qualification status exactly (Req 10.2). When Stage 1
 * failed/absent, fall back to neutral, schema-valid defaults — the schema
 * requires a framework and a fit assessment, so `"unknown"` cannot be used for
 * those two fields; no lead fact is invented.
 */
function buildQualificationStatus(
  qualification: QualificationResult | null,
): HandoffSummary["qualificationStatus"] {
  if (!qualification) {
    return {
      framework: "BANT",
      priorityScore: 0,
      fitAssessment: "weak_fit",
      knownFieldCount: 0,
      unknownSlotLabels: [],
    };
  }

  return {
    framework: qualification.framework,
    priorityScore: qualification.priorityScore,
    fitAssessment: qualification.fitAssessment,
    knownFieldCount: qualification.knownFields.length,
    unknownSlotLabels: qualification.unknownFields.map((field) => field.slotLabel),
  };
}

/** A claim qualifies as a "verified finding" when it is verified and carries a source URL and text. */
function isVerifiedFinding(claim: ResearchClaim): boolean {
  return (
    claim.verificationStatus === "verified" &&
    isKnownString(claim.claimText) &&
    isKnownString(claim.sourceUrl)
  );
}

/**
 * Deterministically rank verified claims by dimension priority, then by
 * numeric-figure presence (claims carrying figures rank higher within a
 * dimension), with the original array order as a stable final tiebreaker.
 */
function rankVerifiedClaims(claims: ResearchClaim[]): ResearchClaim[] {
  return claims
    .map((claim, index) => ({ claim, index }))
    .sort((a, b) => {
      const dimDiff = DIMENSION_PRIORITY[a.claim.dimension] - DIMENSION_PRIORITY[b.claim.dimension];
      if (dimDiff !== 0) return dimDiff;

      const aFigures = a.claim.numericFigures.length > 0 ? 0 : 1;
      const bFigures = b.claim.numericFigures.length > 0 ? 0 : 1;
      if (aFigures !== bFigures) return aFigures - bFigures;

      return a.index - b.index;
    })
    .map((entry) => entry.claim);
}

const UNKNOWN_FINDING: HandoffFinding = {
  claimId: UNKNOWN,
  finding: UNKNOWN,
  sourceUrl: UNKNOWN,
};

/**
 * Select exactly three findings from the Stage 2 verified claims (Req 10.3).
 * Fewer than three verified claims → the remaining slots are filled with the
 * `"unknown"` marker (Req 10.7). Returns both the tuple and the count of
 * verified findings actually available.
 */
function buildTopThreeFindings(research: ResearchReport | null): {
  findings: [HandoffFinding, HandoffFinding, HandoffFinding];
  verifiedFindingsAvailable: number;
} {
  const verified = research ? research.claims.filter(isVerifiedFinding) : [];
  const ranked = rankVerifiedClaims(verified);

  const slotAt = (index: number): HandoffFinding => {
    const claim = ranked[index];
    return claim
      ? {
          claimId: claim.claimId,
          finding: claim.claimText,
          sourceUrl: claim.sourceUrl,
        }
      : { ...UNKNOWN_FINDING };
  };

  return {
    findings: [slotAt(0), slotAt(1), slotAt(2)],
    verifiedFindingsAvailable: verified.length,
  };
}

/**
 * Copy the Stage 4 winner into the recommended-case-study section (Req 10.4).
 * "Why it won" is taken from the Stage 4 comparison statement, or synthesized
 * from the deciding dimensions when no statement is present. Everything is
 * `"unknown"` when there is no winner.
 */
function buildRecommendedCaseStudy(
  match: MatchResult | null,
): HandoffSummary["recommendedCaseStudy"] {
  const winner = match ? resolveUpstream<ScoredCaseStudy>(match.winner) : null;
  if (!winner) {
    return { sourceUrl: UNKNOWN, title: UNKNOWN, whyItWon: UNKNOWN };
  }

  let whyItWon: Maybe<string>;
  if (match && isKnownString(match.comparisonStatement)) {
    whyItWon = match.comparisonStatement;
  } else if (match && match.decidingDimensions.length > 0) {
    whyItWon = `Selected as the closest match on ${match.decidingDimensions.join(", ")}.`;
  } else {
    whyItWon = UNKNOWN;
  }

  return {
    sourceUrl: winner.record.sourceUrl,
    title: winner.record.title,
    whyItWon,
  };
}

/** Deterministic next-step action templated on the Stage 5 motion (Req 10.5). */
function defaultNextStepAction(motion: GtmMotion | typeof UNKNOWN): string {
  switch (motion) {
    case "direct_ae":
      return "Assign the lead to a direct account executive for immediate outbound follow-up.";
    case "partner_led":
      return "Route the lead through a regional channel partner and co-sell the opportunity.";
    default:
      return "Assign the lead to an account executive to confirm the routing motion before follow-up.";
  }
}

/** Deterministic next-step rationale templated on the Stage 5 motion (Req 10.5). */
function defaultNextStepRationale(
  motion: GtmMotion | typeof UNKNOWN,
  gtm: GtmRecommendation | null,
): string {
  const base =
    gtm && gtm.reasoning.trim().length > 0
      ? gtm.reasoning.trim()
      : "Derived from the Stage 5 go-to-market assessment.";
  switch (motion) {
    case "direct_ae":
      return `A direct AE-led motion was recommended. ${base}`;
    case "partner_led":
      return `A partner-led motion was recommended. ${base}`;
    default:
      return `The go-to-market motion could not be determined from upstream stages. ${base}`;
  }
}

// ---------------------------------------------------------------------------
// Deterministic buyer-context fallback
// ---------------------------------------------------------------------------

/** Build a deterministic buyer-context paragraph from stage 1-5 outputs only. */
function buildDeterministicBuyerContext(
  qualification: QualificationResult | null,
  research: ResearchReport | null,
): string {
  const parts: string[] = [];

  if (qualification) {
    const knownValues = qualification.knownFields
      .map((field) => `${field.slotLabel}: ${field.value}`)
      .join("; ");
    parts.push(
      `Qualified with the ${qualification.framework} framework as a ${qualification.fitAssessment.replace(/_/g, " ")} ` +
        `(priority ${qualification.priorityScore}/100).`,
    );
    if (knownValues.length > 0) {
      parts.push(`Known context — ${knownValues}.`);
    }
    if (qualification.unknownFields.length > 0) {
      parts.push(
        `Open questions — ${qualification.unknownFields.map((f) => f.slotLabel).join(", ")}.`,
      );
    }
  } else {
    parts.push("Qualification context is unavailable for this lead.");
  }

  if (research && isKnownString(research.positioningRecommendation.narrative)) {
    parts.push(`Positioning — ${research.positioningRecommendation.narrative}`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Prose composition (one optional LLM call; deterministic fallback)
// ---------------------------------------------------------------------------

/** The prose schema: the LLM returns wording only, never a fact or a URL. */
const proseSchema = z.object({
  buyerContext: z.string().min(1),
  nextStepAction: z.string().min(1),
  nextStepRationale: z.string().min(1),
});

interface ProseResult {
  buyerContext: string;
  nextStepAction: string;
  nextStepRationale: string;
}

/**
 * Compose the buyer-context paragraph and next-step wording with ONE scoped LLM
 * call, grounded only in the already-derived structured facts. On any failure —
 * or an empty result — the deterministic fallback is used, so no new fact can
 * enter and the stage never throws (Req 10.6, 17.1).
 */
async function composeProse(
  ctx: StageContext,
  args: {
    qualificationStatus: HandoffSummary["qualificationStatus"];
    findings: [HandoffFinding, HandoffFinding, HandoffFinding];
    verifiedFindingsAvailable: number;
    recommendedCaseStudy: HandoffSummary["recommendedCaseStudy"];
    motion: GtmMotion | typeof UNKNOWN;
    deterministicBuyerContext: string;
    deterministicNextStepAction: string;
    deterministicNextStepRationale: string;
  },
): Promise<ProseResult> {
  const fallback: ProseResult = {
    buyerContext: args.deterministicBuyerContext,
    nextStepAction: args.deterministicNextStepAction,
    nextStepRationale: args.deterministicNextStepRationale,
  };

  const findingsText = args.findings
    .map((f, i) => `${i + 1}. ${text(f.finding) || UNKNOWN} (source: ${text(f.sourceUrl) || UNKNOWN})`)
    .join("\n");

  const systemPrompt = [
    "You are writing an internal sales-handoff summary for an account executive.",
    "You may ONLY rephrase the structured facts provided; you must NOT introduce any new fact, company, person, number, or URL.",
    "Return a concise buyer-context paragraph, a next-step action, and a next-step rationale.",
    "The go-to-market motion is already decided and must not be changed.",
  ].join(" ");

  const userPrompt = [
    "Structured facts derived from stages 1-5:",
    `Qualification: framework ${args.qualificationStatus.framework}, priority ${args.qualificationStatus.priorityScore}/100, ` +
      `fit ${args.qualificationStatus.fitAssessment}, known fields ${args.qualificationStatus.knownFieldCount}, ` +
      `open slots: ${args.qualificationStatus.unknownSlotLabels.join(", ") || "none"}.`,
    `Top research findings (${args.verifiedFindingsAvailable} verified available):`,
    findingsText,
    `Recommended case study: ${text(args.recommendedCaseStudy.title) || UNKNOWN} ` +
      `(${text(args.recommendedCaseStudy.sourceUrl) || UNKNOWN}) — ${text(args.recommendedCaseStudy.whyItWon) || UNKNOWN}.`,
    `Decided go-to-market motion: ${args.motion}.`,
    "",
    "Grounding drafts you may refine (keep every fact intact):",
    `Buyer context: ${args.deterministicBuyerContext}`,
    `Next-step action: ${args.deterministicNextStepAction}`,
    `Next-step rationale: ${args.deterministicNextStepRationale}`,
  ].join("\n");

  try {
    const result = await ctx.llm.completeJson({
      purpose: "stage6_handoff_prose",
      systemPrompt,
      userPrompt,
      schema: proseSchema,
      maxOutputTokens: 600,
      temperature: 0.2,
    });

    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "llm_call",
      message: "Composed handoff buyer-context and next-step prose.",
      llmCall: {
        provider: ctx.llm.name,
        model: result.modelUsed,
        purpose: "stage6_handoff_prose",
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        attempt: ctx.attempt,
      },
    });

    const buyerContext = result.value.buyerContext.trim();
    const nextStepAction = result.value.nextStepAction.trim();
    const nextStepRationale = result.value.nextStepRationale.trim();

    return {
      buyerContext: buyerContext.length > 0 ? buyerContext : fallback.buyerContext,
      nextStepAction: nextStepAction.length > 0 ? nextStepAction : fallback.nextStepAction,
      nextStepRationale:
        nextStepRationale.length > 0 ? nextStepRationale : fallback.nextStepRationale,
    };
  } catch {
    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "reasoning",
      message: "Handoff prose LLM call failed; using deterministic narrative.",
    });
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Stage module
// ---------------------------------------------------------------------------

export const stage6HandoffGenerator: Stage<HandoffSummary> = {
  stage: STAGE,
  stageName: STAGE_NAME,
  sourceFile: SOURCE_FILE,
  dependsOn: DEPENDS_ON,
  usesToolbelt: false,
  schema: handoffSummarySchema,

  async run(ctx: StageContext): Promise<HandoffSummary> {
    // Resolve each upstream stage output, treating "unknown"/undefined as absent.
    const qualification = resolveUpstream<QualificationResult>(ctx.upstream.qualification);
    const research = resolveUpstream<ResearchReport>(ctx.upstream.research);
    const match = resolveUpstream<MatchResult>(ctx.upstream.match);
    const gtm = resolveUpstream<GtmRecommendation>(ctx.upstream.gtm);

    // Structural sections — all deterministic, derived only from stages 1-5.
    const qualificationStatus = buildQualificationStatus(qualification);
    const { findings, verifiedFindingsAvailable } = buildTopThreeFindings(research);
    const recommendedCaseStudy = buildRecommendedCaseStudy(match);

    const motion: GtmMotion | typeof UNKNOWN = gtm ? gtm.motion : UNKNOWN;
    const deterministicBuyerContext = buildDeterministicBuyerContext(qualification, research);
    const deterministicNextStepAction = defaultNextStepAction(motion);
    const deterministicNextStepRationale = defaultNextStepRationale(motion, gtm);

    // One optional LLM call composes prose from the derived facts only.
    const prose = await composeProse(ctx, {
      qualificationStatus,
      findings,
      verifiedFindingsAvailable,
      recommendedCaseStudy,
      motion,
      deterministicBuyerContext,
      deterministicNextStepAction,
      deterministicNextStepRationale,
    });

    ctx.emit({
      stage: STAGE,
      stageName: STAGE_NAME,
      type: "reasoning",
      message:
        `Handoff summary derived from stages 1-5 ` +
        `(${verifiedFindingsAvailable} verified findings available; motion "${motion}").`,
    });

    return {
      buyerContext: prose.buyerContext,
      qualificationStatus,
      topThreeFindings: findings,
      verifiedFindingsAvailable,
      recommendedCaseStudy,
      suggestedNextStep: {
        action: prose.nextStepAction,
        rationale: prose.nextStepRationale,
        consistentWithMotion: motion,
      },
    };
  },
};

export default stage6HandoffGenerator;
