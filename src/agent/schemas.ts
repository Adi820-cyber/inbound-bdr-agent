/**
 * Zod schemas mirroring the shared contracts in `src/agent/contracts.ts`
 * (Req 13.5, 17.4).
 *
 * These schemas are the single source of truth for three jobs:
 *  - LLM output validation at the `completeJson` boundary,
 *  - route input validation, and
 *  - store serialization (`deserialize(serialize(a))` must equal `a`).
 *
 * Every *data* contract type has exactly one schema here. The behavioral
 * interfaces that carry methods (`ResearchToolbelt`, `LlmProvider`,
 * `SearchProvider`, `LlmThrottle`, `Stage`, `StageContext`) are intentionally
 * NOT mirrored: functions do not serialize and cannot be validated at a data
 * boundary. Everything that crosses the store, an LLM boundary, or an HTTP
 * boundary is covered below.
 *
 * Two conventions carried over from the contracts:
 *  - `Unknown` is the literal string `"unknown"`, never `null`. `Maybe<T>` is
 *    `T | "unknown"`. (Note that `Maybe<string>` collapses to `string` at the
 *    type level because `"unknown"` is itself a `string` — this is expected and
 *    the cross-checks at the bottom of the file account for it.)
 *  - Every timestamp is an ISO-8601 string, so store round-trips stay exact.
 */

import { z } from "zod";
import type {
  CaseStudyRecord,
  ComplexityAssessment,
  DimensionScore,
  EmailDraft,
  EmailSequence,
  FetchedPage,
  FetchLedgerEntry,
  FrameworkSlot,
  GtmRecommendation,
  HandoffFinding,
  HandoffSummary,
  KnownField,
  LeadProfile,
  MatchResult,
  NumericFigure,
  OpenAiCompatibleConfig,
  PartnerEvidence,
  PartnerType,
  PositioningAssertion,
  PositioningRecommendation,
  QualificationResult,
  RawEmailRecord,
  ResearchClaim,
  ResearchReport,
  RunArtifact,
  RunSummary,
  ScoreBreakdown,
  ScoredCaseStudy,
  ScoreFactor,
  SearchHit,
  StageEvent,
  StageRecord,
  ThrottleEvent,
  UnknownField,
} from "./contracts";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** The literal `"unknown"` — the only substitution allowed for a missing value. */
export const unknownSchema = z.literal("unknown");

/** `Maybe<T>` = `T | "unknown"`. */
const maybe = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, unknownSchema]);

/** ISO-8601 UTC timestamp kept as a string so store round-trips stay exact. */
export const isoTimestampSchema = z.string();

export const stageNumberSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

export const stageStatusSchema = z.enum(["pending", "running", "complete", "failed"]);
export const runStatusSchema = z.enum(["running", "complete", "partial", "failed"]);
export const verificationStatusSchema = z.enum(["verified", "unknown", "stale"]);
export const researchDimensionSchema = z.enum([
  "org_structure",
  "budget_signals",
  "recent_news",
  "leadership_language",
  "positioning",
]);

/** Every key of `LeadProfile`, so `keyof LeadProfile` fields validate exactly. */
export const leadProfileKeySchema = z.enum([
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
]);

// ---------------------------------------------------------------------------
// Lead Input and Profile
// ---------------------------------------------------------------------------

export const rawEmailRecordSchema = z.object({
  fromName: z.string(),
  fromEmail: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: isoTimestampSchema.optional(),
  formFields: z.record(z.string(), z.string()).optional(),
});

export const leadProfileSchema = z.object({
  leadId: z.string(),
  senderName: maybe(z.string()),
  senderEmail: maybe(z.string()),
  title: maybe(z.string()),
  division: maybe(z.string()),
  company: maybe(z.string()),
  companyDomain: maybe(z.string()),
  country: maybe(z.string()),
  region: maybe(z.string()),
  industry: maybe(z.string()),
  statedUseCase: maybe(z.string()),
  statedPainPoints: z.array(z.string()),
  referralSource: maybe(z.string()),
  statedTimeline: maybe(z.string()),
  siteCount: maybe(z.number()),
  rawEmail: rawEmailRecordSchema,
  normalizedAt: isoTimestampSchema,
});

// ---------------------------------------------------------------------------
// Stage 1 — Qualification
// ---------------------------------------------------------------------------

export const qualificationFrameworkSchema = z.enum(["MEDDPICC", "BANT", "SPICED"]);
export const fitAssessmentSchema = z.enum(["strong_fit", "moderate_fit", "weak_fit"]);

export const frameworkSlotSchema = z.object({
  slotId: z.string(),
  slotLabel: z.string(),
});

export const knownFieldSchema = z.object({
  slotId: z.string(),
  slotLabel: z.string(),
  value: z.string(),
  sourceLeadField: leadProfileKeySchema,
  evidenceQuote: z.string(),
});

export const unknownFieldSchema = z.object({
  slotId: z.string(),
  slotLabel: z.string(),
  whyItMatters: z.string(),
});

export const scoreFactorSchema = z.object({
  factor: z.string(),
  contribution: z.number(),
  explanation: z.string(),
});

export const qualificationResultSchema = z.object({
  framework: qualificationFrameworkSchema,
  frameworkSlots: z.array(frameworkSlotSchema),
  frameworkSelectionJustification: z.string(),
  // At least two distinct lead attributes must justify the framework (Req 3.2).
  justificationLeadAttributes: z.array(leadProfileKeySchema).min(2),
  knownFields: z.array(knownFieldSchema),
  unknownFields: z.array(unknownFieldSchema),
  // Integer 0..100 (Req 3.5).
  priorityScore: z.number().int().min(0).max(100),
  scoreFactors: z.array(scoreFactorSchema),
  scoreReasoning: z.string(),
  fitAssessment: fitAssessmentSchema,
});

// ---------------------------------------------------------------------------
// Stage 2 — Research
// ---------------------------------------------------------------------------

export const numericFigureSchema = z.object({
  label: z.string(),
  value: z.string(),
  sourceUrl: z.string(), // required (Req 5.6)
});

export const researchClaimSchema = z.object({
  claimId: z.string(),
  dimension: researchDimensionSchema,
  claimText: maybe(z.string()),
  sourceUrl: maybe(z.string()),
  supportingQuote: maybe(z.string()),
  retrievedAt: maybe(isoTimestampSchema),
  verificationStatus: verificationStatusSchema,
  numericFigures: z.array(numericFigureSchema),
  rejectionReason: z.string().optional(),
});

export const positioningAssertionSchema = z.object({
  assertion: z.string(),
  supportingClaimIds: z.array(z.string()).min(1), // length >= 1 (Req 4.6)
});

export const positioningRecommendationSchema = z.object({
  narrative: z.string(),
  assertions: z.array(positioningAssertionSchema),
});

export const researchReportSchema = z.object({
  claims: z.array(researchClaimSchema),
  claimsByDimension: z.record(researchDimensionSchema, z.array(z.string())),
  positioningRecommendation: positioningRecommendationSchema,
  dimensionsWithNoSource: z.array(researchDimensionSchema),
  verifiedClaimCount: z.number(),
});

// ---------------------------------------------------------------------------
// Stage 3 — Email Sequence
// ---------------------------------------------------------------------------

export const emailDraftSchema = z.object({
  position: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  subject: z.string(),
  body: z.string(),
  referencedClaimIds: z.array(z.string()).min(1), // length >= 1 (Req 6.2)
  targetedUnknownSlotIds: z.array(z.string()).min(1).max(2), // length 1..2 (Req 6.3)
  sendTimingGuidance: z.string(),
  progressionRationale: maybe(z.string()),
});

export const emailSequenceSchema = z.object({
  // Exactly three drafts (Req 6.1).
  emails: z.tuple([emailDraftSchema, emailDraftSchema, emailDraftSchema]),
  coveredUnknownSlotIds: z.array(z.string()).min(3), // >= 3 distinct (Req 6.4)
  personaAdaptationNote: z.string(),
  researchUnavailableNotice: maybe(z.string()),
});

// ---------------------------------------------------------------------------
// Stage 4 — Case Studies and Matching
// ---------------------------------------------------------------------------

export const caseStudyRecordSchema = z.object({
  sourceUrl: z.string(),
  title: maybe(z.string()),
  industry: maybe(z.string()),
  region: maybe(z.string()),
  useCase: maybe(z.string()),
  namedPartner: maybe(z.string()),
  statedResults: maybe(z.string()),
  verificationStatus: verificationStatusSchema,
  retrievedAt: maybe(isoTimestampSchema),
});

export const rubricDimensionSchema = z.enum([
  "industry",
  "geography",
  "useCase",
  "partnerOverlap",
]);

export const dimensionScoreSchema = z.object({
  dimension: rubricDimensionSchema,
  weight: z.number(),
  subScore: z.number().min(0).max(1), // 0.0..1.0
  contribution: z.number(),
  leadValue: maybe(z.string()),
  caseStudyValue: maybe(z.string()),
  unknownInput: z.boolean(),
  reason: z.string(),
});

export const scoreBreakdownSchema = z.object({
  dimensions: z.array(dimensionScoreSchema),
  matchScore: z.number().min(0).max(1), // 0.0..1.0 (Req 8.6)
});

export const scoredCaseStudySchema = z.object({
  record: caseStudyRecordSchema,
  breakdown: scoreBreakdownSchema,
  rank: z.number(),
});

export const matchResultSchema = z.object({
  corpusSize: z.number(),
  rankedCorpus: z.array(scoredCaseStudySchema),
  winner: maybe(scoredCaseStudySchema),
  runnerUp: maybe(scoredCaseStudySchema),
  comparisonStatement: maybe(z.string()),
  decidingDimensions: z.array(rubricDimensionSchema),
  rubricWeights: z.record(rubricDimensionSchema, z.number()),
  corpusProvenance: z.enum(["live", "cached", "unavailable"]),
  cachedSnapshotAt: maybe(isoTimestampSchema),
});

// ---------------------------------------------------------------------------
// Stage 5 — GTM Recommendation
// ---------------------------------------------------------------------------

export const gtmMotionSchema = z.enum(["direct_ae", "partner_led"]);

export const partnerTypeSchema = z.union([
  z.enum([
    "systems_integrator",
    "drone_service_provider",
    "hardware_reseller",
    "industrial_automation_consultancy",
  ]),
  unknownSchema,
]);

export const partnerEvidenceSchema = z.object({
  found: z.boolean(),
  partnerNames: z.array(z.string()),
  sourceUrl: maybe(z.string()),
  supportingQuote: maybe(z.string()),
  retrievedAt: maybe(isoTimestampSchema),
});

export const complexityAssessmentSchema = z.object({
  complexityScore: z.number(),
  signals: z.object({
    siteCount: maybe(z.number()),
    continuousOperations: z.boolean(),
    regulatedEnvironment: z.boolean(),
    multiStakeholder: z.boolean(),
    dealSizeIndicator: z.union([z.enum(["small", "mid", "large"]), unknownSchema]),
  }),
  explanation: z.string(),
});

export const gtmRecommendationSchema = z.object({
  motion: gtmMotionSchema,
  reasoning: z.string(),
  geographyConsidered: maybe(z.string()),
  complexity: complexityAssessmentSchema,
  regionalPartnerEvidence: maybe(partnerEvidenceSchema),
  derivedWithoutPartnerEvidence: z.boolean(),
  partnerType: maybe(partnerTypeSchema),
  decisionInputsSnapshot: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
});

// ---------------------------------------------------------------------------
// Stage 6 — Handoff Summary
// ---------------------------------------------------------------------------

export const handoffFindingSchema = z.object({
  claimId: maybe(z.string()),
  finding: maybe(z.string()),
  sourceUrl: maybe(z.string()),
});

export const handoffSummarySchema = z.object({
  buyerContext: z.string(),
  qualificationStatus: z.object({
    framework: qualificationFrameworkSchema,
    priorityScore: z.number(),
    fitAssessment: fitAssessmentSchema,
    knownFieldCount: z.number(),
    unknownSlotLabels: z.array(z.string()),
  }),
  topThreeFindings: z.tuple([
    handoffFindingSchema,
    handoffFindingSchema,
    handoffFindingSchema,
  ]),
  verifiedFindingsAvailable: z.number(),
  recommendedCaseStudy: z.object({
    sourceUrl: maybe(z.string()),
    title: maybe(z.string()),
    whyItWon: maybe(z.string()),
  }),
  suggestedNextStep: z.object({
    action: z.string(),
    rationale: z.string(),
    consistentWithMotion: z.union([gtmMotionSchema, unknownSchema]),
  }),
});

// ---------------------------------------------------------------------------
// Provenance, Events, and Artifact
// ---------------------------------------------------------------------------

export const fetchLedgerEntrySchema = z.object({
  entryId: z.string(),
  runId: z.string(),
  stage: stageNumberSchema,
  kind: z.enum(["search", "page_fetch"]),
  requestedUrl: z.string(),
  finalUrl: maybe(z.string()),
  normalizedUrl: z.string(),
  query: maybe(z.string()),
  statusCode: maybe(z.number()),
  ok: z.boolean(),
  errorKind: maybe(z.enum(["timeout", "network", "http_error", "parse_error"])),
  retrievedAt: isoTimestampSchema,
  contentBytes: maybe(z.number()),
  contentHash: maybe(z.string()),
});

export const stageEventTypeSchema = z.enum([
  "run_started",
  "stage_started",
  "tool_call",
  "tool_error",
  "reasoning",
  "llm_call",
  "validation_error",
  "unknown_substitution",
  "stage_completed",
  "stage_failed",
  "run_completed",
]);

export const stageEventSchema = z.object({
  seq: z.number(),
  eventId: z.string(),
  runId: z.string(),
  stage: z.union([stageNumberSchema, z.null()]),
  stageName: z.union([z.string(), z.null()]),
  type: stageEventTypeSchema,
  timestamp: isoTimestampSchema,
  message: z.string(),
  inputSummary: z.string().optional(),
  toolCall: z
    .object({
      kind: z.enum(["search", "page_fetch"]),
      urlOrQuery: z.string(),
      statusCode: maybe(z.number()),
      retrievedAt: isoTimestampSchema,
    })
    .optional(),
  llmCall: z
    .object({
      provider: z.string(),
      model: z.string(),
      purpose: z.string(),
      promptTokens: maybe(z.number()),
      completionTokens: maybe(z.number()),
      attempt: z.number(),
      fallbackModelUsed: z.boolean().optional(),
      throttled: z.boolean().optional(),
      throttleWaitMs: z.number().optional(),
      rateLimited: z.boolean().optional(),
      retryAfterMs: maybe(z.number()).optional(),
    })
    .optional(),
  stageStatus: stageStatusSchema.optional(),
  output: z.unknown().optional(),
  rejectedUrl: z.string().optional(),
  substitutedField: z.string().optional(),
  durationMs: z.number().optional(),
});

/** Generic `StageRecord<T>` schema, parameterized by the stage's output schema. */
export const stageRecordSchema = <T extends z.ZodTypeAny>(output: T) =>
  z.object({
    stage: stageNumberSchema,
    stageName: z.string(),
    sourceFile: z.string(),
    status: stageStatusSchema,
    attempts: z.number(),
    startedAt: maybe(isoTimestampSchema),
    completedAt: maybe(isoTimestampSchema),
    durationMs: maybe(z.number()),
    output: z.union([output, unknownSchema]),
    failureReason: maybe(z.string()),
  });

export const runArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  status: runStatusSchema,
  startedAt: isoTimestampSchema,
  completedAt: maybe(isoTimestampSchema),
  leadProfile: leadProfileSchema,
  providerConfig: z.object({
    llmProvider: z.string(),
    llmModel: z.string(),
    llmFallbackModel: maybe(z.string()),
    llmMaxRpm: z.number(),
    searchProvider: z.string(),
    runStoreBackend: z.enum(["upstash", "json_file"]),
    runStoreDurable: z.boolean(),
  }),
  stages: z.object({
    stage1: stageRecordSchema(qualificationResultSchema),
    stage2: stageRecordSchema(researchReportSchema),
    stage3: stageRecordSchema(emailSequenceSchema),
    stage4: stageRecordSchema(matchResultSchema),
    stage5: stageRecordSchema(gtmRecommendationSchema),
    stage6: stageRecordSchema(handoffSummarySchema),
  }),
  events: z.array(stageEventSchema),
  fetchLedger: z.array(fetchLedgerEntrySchema),
  unknownFieldReport: z.array(
    z.object({
      dimension: maybe(researchDimensionSchema),
      field: z.string(),
      reason: z.string(),
    }),
  ),
});

export const runSummarySchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  company: maybe(z.string()),
  startedAt: isoTimestampSchema,
  verifiedClaimCount: z.number(),
});

// ---------------------------------------------------------------------------
// LLM Call Throttle
// ---------------------------------------------------------------------------

export const throttleEventSchema = z.object({
  purpose: z.string(),
  waitMs: z.number(),
  windowStartsInFlight: z.number(),
  maxRpm: z.number(),
});

// ---------------------------------------------------------------------------
// Provider data types (no methods — safe to mirror)
// ---------------------------------------------------------------------------

export const searchHitSchema = z.object({
  url: z.string(),
  title: maybe(z.string()),
  snippet: maybe(z.string()),
  publishedDate: maybe(z.string()),
});

export const fetchedPageSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  statusCode: z.number(),
  text: z.string(),
  retrievedAt: isoTimestampSchema,
  fromCache: z.boolean(),
});

export const openAiCompatibleConfigSchema = z.object({
  name: z.enum(["openai", "openrouter"]),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  fallbackModel: maybe(z.string()),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Compile-time cross-checks: every schema's inferred type must equal the
// contract type it mirrors. These produce no runtime code; they exist so that
// `tsc --noEmit` fails loudly if a schema and its contract ever drift apart.
// ---------------------------------------------------------------------------

/** True only when A and B are mutually assignable (structurally identical). */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Records the type-level assertion; the `true` bound is what enforces it. */
const assertExact = <_T extends true>(): void => {
  /* type-level only */
};

// StageRecord<T> is generic; check it against a representative instantiation.
type StageRecordOf<T> = StageRecord<T>;

assertExact<Exact<z.infer<typeof rawEmailRecordSchema>, RawEmailRecord>>();
assertExact<Exact<z.infer<typeof leadProfileSchema>, LeadProfile>>();
assertExact<Exact<z.infer<typeof frameworkSlotSchema>, FrameworkSlot>>();
assertExact<Exact<z.infer<typeof knownFieldSchema>, KnownField>>();
assertExact<Exact<z.infer<typeof unknownFieldSchema>, UnknownField>>();
assertExact<Exact<z.infer<typeof scoreFactorSchema>, ScoreFactor>>();
assertExact<Exact<z.infer<typeof qualificationResultSchema>, QualificationResult>>();
assertExact<Exact<z.infer<typeof numericFigureSchema>, NumericFigure>>();
assertExact<Exact<z.infer<typeof researchClaimSchema>, ResearchClaim>>();
assertExact<Exact<z.infer<typeof positioningAssertionSchema>, PositioningAssertion>>();
assertExact<
  Exact<z.infer<typeof positioningRecommendationSchema>, PositioningRecommendation>
>();
assertExact<Exact<z.infer<typeof researchReportSchema>, ResearchReport>>();
assertExact<Exact<z.infer<typeof emailDraftSchema>, EmailDraft>>();
assertExact<Exact<z.infer<typeof emailSequenceSchema>, EmailSequence>>();
assertExact<Exact<z.infer<typeof caseStudyRecordSchema>, CaseStudyRecord>>();
assertExact<Exact<z.infer<typeof dimensionScoreSchema>, DimensionScore>>();
assertExact<Exact<z.infer<typeof scoreBreakdownSchema>, ScoreBreakdown>>();
assertExact<Exact<z.infer<typeof scoredCaseStudySchema>, ScoredCaseStudy>>();
assertExact<Exact<z.infer<typeof matchResultSchema>, MatchResult>>();
assertExact<Exact<z.infer<typeof partnerTypeSchema>, PartnerType>>();
assertExact<Exact<z.infer<typeof partnerEvidenceSchema>, PartnerEvidence>>();
assertExact<Exact<z.infer<typeof complexityAssessmentSchema>, ComplexityAssessment>>();
assertExact<Exact<z.infer<typeof gtmRecommendationSchema>, GtmRecommendation>>();
assertExact<Exact<z.infer<typeof handoffFindingSchema>, HandoffFinding>>();
assertExact<Exact<z.infer<typeof handoffSummarySchema>, HandoffSummary>>();
assertExact<Exact<z.infer<typeof fetchLedgerEntrySchema>, FetchLedgerEntry>>();
assertExact<Exact<z.infer<typeof stageEventSchema>, StageEvent>>();
assertExact<
  Exact<
    z.infer<ReturnType<typeof stageRecordSchema<typeof qualificationResultSchema>>>,
    StageRecordOf<QualificationResult>
  >
>();
assertExact<Exact<z.infer<typeof runArtifactSchema>, RunArtifact>>();
assertExact<Exact<z.infer<typeof runSummarySchema>, RunSummary>>();
assertExact<Exact<z.infer<typeof throttleEventSchema>, ThrottleEvent>>();
assertExact<Exact<z.infer<typeof searchHitSchema>, SearchHit>>();
assertExact<Exact<z.infer<typeof fetchedPageSchema>, FetchedPage>>();
assertExact<Exact<z.infer<typeof openAiCompatibleConfigSchema>, OpenAiCompatibleConfig>>();
