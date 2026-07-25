/**
 * Shared fast-check arbitraries for the Inbound BDR Agent property suite
 * (Req 13.5).
 *
 * Every generator here produces values that are both assignable to their
 * contract type in `src/agent/contracts.ts` and valid against the matching Zod
 * schema in `src/agent/schemas.ts`. The generators deliberately reach for the
 * edge cases the requirements call out so those cases are covered by the
 * generators rather than by separate hand-written tests:
 *
 *   - the literal `"unknown"` in every `Maybe<T>` field position,
 *   - empty strings,
 *   - unicode including CJK and emoji,
 *   - embedded newlines and delimiter characters,
 *   - very long strings,
 *   - adversarial URL shapes.
 *
 * `arbThrottleSchedule` is the odd one out: it produces the raw inputs for
 * Property 38 (submission offsets, per-call durations, and an RPM ceiling of
 * one or more) rather than a contract type.
 */

import fc from "fast-check";

import { UNKNOWN } from "@/agent/contracts";
import type {
  CaseStudyRecord,
  ComplexityAssessment,
  DimensionScore,
  EmailDraft,
  EmailSequence,
  FetchLedgerEntry,
  FitAssessment,
  FrameworkSlot,
  GtmMotion,
  GtmRecommendation,
  HandoffFinding,
  HandoffSummary,
  KnownField,
  LeadProfile,
  Maybe,
  MatchResult,
  NumericFigure,
  PartnerEvidence,
  PartnerType,
  PositioningAssertion,
  PositioningRecommendation,
  QualificationFramework,
  QualificationResult,
  RawEmailRecord,
  ResearchClaim,
  ResearchDimension,
  ResearchReport,
  RubricDimension,
  RunArtifact,
  RunStatus,
  ScoreBreakdown,
  ScoredCaseStudy,
  ScoreFactor,
  StageEvent,
  StageEventType,
  StageNumber,
  StageRecord,
  StageStatus,
  Unknown,
  UnknownField,
  VerificationStatus,
} from "@/agent/contracts";

// ---------------------------------------------------------------------------
// Edge-case primitives
// ---------------------------------------------------------------------------

/** CJK, emoji, accented, and other multi-byte unicode samples. */
const UNICODE_SAMPLES: readonly string[] = [
  "你好世界",
  "日本語テスト",
  "한국어",
  "Ωμέγα",
  "café",
  "Zürich",
  "naïve",
  "🚀🔥😀",
  "👩‍💻👨‍👩‍👧‍👦",
  "𝕏𝕐𝕑",
  "İıĞğŞşÇç",
  "مرحبا",
];

/** Embedded newlines, tabs, quotes, and CSV/JSON delimiter characters. */
const DELIMITER_SAMPLES: readonly string[] = [
  "line1\nline2",
  "line1\r\nline2",
  "col1\tcol2",
  "a,b,c",
  "a;b;c",
  "a|b|c",
  'quote"inside',
  "apostrophe'inside",
  "<script>alert(1)</script>",
  '{"embedded":"json"}',
  "back\\slash",
  "trailing space ",
];

/** Adversarial URL shapes — none need to parse; every URL field is `z.string()`. */
const ADVERSARIAL_URLS: readonly string[] = [
  "",
  "unknown",
  "not a url at all",
  "http://",
  "https://",
  "//protocol-relative.example.com/path",
  "javascript:alert(document.cookie)",
  "data:text/html,<h1>x</h1>",
  "ftp://files.example.com/a",
  "https://例え.テスト/パス?q=検索",
  "https://user:p@ss@host:99999/a/b?x=<>#frag",
  "https://.com",
  "HTTPS://UPPER.EXAMPLE.COM/PATH",
  "https://example.com/" + "segment/".repeat(300),
];

/** A string generator that folds in every called-out edge case (Req 13.5). */
export const arbEdgeString: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constant(""),
  fc.constant(UNKNOWN),
  fc.constantFrom(...UNICODE_SAMPLES),
  fc.constantFrom(...DELIMITER_SAMPLES),
  fc.string({ minLength: 400, maxLength: 1200 }), // very long
);

/** Adversarial-plus-normal URL strings. */
export const arbUrl: fc.Arbitrary<string> = fc.oneof(
  fc.webUrl(),
  fc.constantFrom(...ADVERSARIAL_URLS),
);

/** The literal `"unknown"`. */
export const arbUnknown: fc.Arbitrary<Unknown> = fc.constant(UNKNOWN);

/** `Maybe<T>` = `T | "unknown"`; always reaches the `"unknown"` branch. */
export const arbMaybe = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<Maybe<T>> =>
  fc.oneof(arb, arbUnknown);

/**
 * `Maybe<string>`. Because `"unknown"` is itself a string, this collapses to
 * `string` at the type level — `arbEdgeString` already emits `"unknown"`.
 */
const arbMaybeString: fc.Arbitrary<string> = arbEdgeString;

/** Finite double (no NaN, no infinity) — valid for every `z.number()`. */
const arbNumber: fc.Arbitrary<number> = fc.double({
  noNaN: true,
  noDefaultInfinity: true,
});

/** Non-negative integer, e.g. counts and durations. */
const arbNonNegInt: fc.Arbitrary<number> = fc.nat();

/** A number in the closed unit interval [0, 1]. */
const arbUnitInterval: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

/** ISO-8601 timestamp string derived from a valid epoch. */
const arbIsoTimestamp: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 4102444800000 }) // 1970-01-01 .. 2100-01-01
  .map((ms) => new Date(ms).toISOString());

/** `Maybe<IsoTimestamp>` — explicitly reaches the `"unknown"` branch. */
const arbMaybeTimestamp: fc.Arbitrary<string> = fc.oneof(arbIsoTimestamp, arbUnknown);

// ---------------------------------------------------------------------------
// Enum-shaped primitives
// ---------------------------------------------------------------------------

const arbStageNumber: fc.Arbitrary<StageNumber> = fc.constantFrom(
  ...([1, 2, 3, 4, 5, 6] as const),
);
const arbStageStatus: fc.Arbitrary<StageStatus> = fc.constantFrom(
  ...(["pending", "running", "complete", "failed"] as const),
);
const arbRunStatus: fc.Arbitrary<RunStatus> = fc.constantFrom(
  ...(["running", "complete", "partial", "failed"] as const),
);
const arbVerificationStatus: fc.Arbitrary<VerificationStatus> = fc.constantFrom(
  ...(["verified", "unknown", "stale"] as const),
);
const arbResearchDimension: fc.Arbitrary<ResearchDimension> = fc.constantFrom(
  ...([
    "org_structure",
    "budget_signals",
    "recent_news",
    "leadership_language",
    "positioning",
  ] as const),
);
const arbQualificationFramework: fc.Arbitrary<QualificationFramework> = fc.constantFrom(
  ...(["MEDDPICC", "BANT", "SPICED"] as const),
);
const arbFitAssessment: fc.Arbitrary<FitAssessment> = fc.constantFrom(
  ...(["strong_fit", "moderate_fit", "weak_fit"] as const),
);
const arbRubricDimension: fc.Arbitrary<RubricDimension> = fc.constantFrom(
  ...(["industry", "geography", "useCase", "partnerOverlap"] as const),
);
const arbGtmMotion: fc.Arbitrary<GtmMotion> = fc.constantFrom(
  ...(["direct_ae", "partner_led"] as const),
);
const arbPartnerType: fc.Arbitrary<PartnerType> = fc.constantFrom(
  ...([
    "systems_integrator",
    "drone_service_provider",
    "hardware_reseller",
    "industrial_automation_consultancy",
    "unknown",
  ] as const),
);

/** Every key of `LeadProfile`, for `sourceLeadField` / `justificationLeadAttributes`. */
const arbLeadProfileKey: fc.Arbitrary<keyof LeadProfile> = fc.constantFrom(
  ...([
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
  ] as const),
);

// ---------------------------------------------------------------------------
// Lead input and profile
// ---------------------------------------------------------------------------

export const arbRawEmail: fc.Arbitrary<RawEmailRecord> = fc.record(
  {
    fromName: arbEdgeString,
    fromEmail: arbEdgeString,
    subject: arbEdgeString,
    body: arbEdgeString,
    receivedAt: arbIsoTimestamp,
    formFields: fc.dictionary(arbEdgeString, arbEdgeString),
  },
  { requiredKeys: ["fromName", "fromEmail", "subject", "body"] },
);

export const arbLeadProfile: fc.Arbitrary<LeadProfile> = fc.record({
  leadId: arbEdgeString,
  senderName: arbMaybeString,
  senderEmail: arbMaybeString,
  title: arbMaybeString,
  division: arbMaybeString,
  company: arbMaybeString,
  companyDomain: arbMaybeString,
  country: arbMaybeString,
  region: arbMaybeString,
  industry: arbMaybeString,
  statedUseCase: arbMaybeString,
  statedPainPoints: fc.array(arbEdgeString),
  referralSource: arbMaybeString,
  statedTimeline: arbMaybeString,
  siteCount: arbMaybe(arbNumber),
  rawEmail: arbRawEmail,
  normalizedAt: arbIsoTimestamp,
});

// ---------------------------------------------------------------------------
// Stage 1 — Qualification
// ---------------------------------------------------------------------------

const arbFrameworkSlot: fc.Arbitrary<FrameworkSlot> = fc.record({
  slotId: arbEdgeString,
  slotLabel: arbEdgeString,
});

const arbKnownField: fc.Arbitrary<KnownField> = fc.record({
  slotId: arbEdgeString,
  slotLabel: arbEdgeString,
  value: arbEdgeString,
  sourceLeadField: arbLeadProfileKey,
  evidenceQuote: arbEdgeString,
});

const arbUnknownField: fc.Arbitrary<UnknownField> = fc.record({
  slotId: arbEdgeString,
  slotLabel: arbEdgeString,
  whyItMatters: arbEdgeString,
});

const arbScoreFactor: fc.Arbitrary<ScoreFactor> = fc.record({
  factor: arbEdgeString,
  contribution: arbNumber,
  explanation: arbEdgeString,
});

export const arbQualificationResult: fc.Arbitrary<QualificationResult> = fc.record({
  framework: arbQualificationFramework,
  frameworkSlots: fc.array(arbFrameworkSlot),
  frameworkSelectionJustification: arbEdgeString,
  // At least two distinct lead attributes (Req 3.2).
  justificationLeadAttributes: fc.array(arbLeadProfileKey, {
    minLength: 2,
    maxLength: 6,
  }),
  knownFields: fc.array(arbKnownField),
  unknownFields: fc.array(arbUnknownField),
  priorityScore: fc.integer({ min: 0, max: 100 }), // integer 0..100 (Req 3.5)
  scoreFactors: fc.array(arbScoreFactor),
  scoreReasoning: arbEdgeString,
  fitAssessment: arbFitAssessment,
});

// ---------------------------------------------------------------------------
// Stage 2 — Research
// ---------------------------------------------------------------------------

const arbNumericFigure: fc.Arbitrary<NumericFigure> = fc.record({
  label: arbEdgeString,
  value: arbEdgeString,
  sourceUrl: arbUrl,
});

export const arbResearchClaim: fc.Arbitrary<ResearchClaim> = fc.record(
  {
    claimId: arbEdgeString,
    dimension: arbResearchDimension,
    claimText: arbMaybeString,
    sourceUrl: fc.oneof(arbUrl, arbUnknown),
    supportingQuote: arbMaybeString,
    retrievedAt: arbMaybeTimestamp,
    verificationStatus: arbVerificationStatus,
    numericFigures: fc.array(arbNumericFigure),
    rejectionReason: arbEdgeString,
  },
  {
    requiredKeys: [
      "claimId",
      "dimension",
      "claimText",
      "sourceUrl",
      "supportingQuote",
      "retrievedAt",
      "verificationStatus",
      "numericFigures",
    ],
  },
);

const arbPositioningAssertion: fc.Arbitrary<PositioningAssertion> = fc.record({
  assertion: arbEdgeString,
  supportingClaimIds: fc.array(arbEdgeString, { minLength: 1 }), // >= 1 (Req 4.6)
});

const arbPositioningRecommendation: fc.Arbitrary<PositioningRecommendation> = fc.record({
  narrative: arbEdgeString,
  assertions: fc.array(arbPositioningAssertion),
});

export const arbResearchReport: fc.Arbitrary<ResearchReport> = fc.record({
  claims: fc.array(arbResearchClaim),
  claimsByDimension: fc.record({
    org_structure: fc.array(arbEdgeString),
    budget_signals: fc.array(arbEdgeString),
    recent_news: fc.array(arbEdgeString),
    leadership_language: fc.array(arbEdgeString),
    positioning: fc.array(arbEdgeString),
  }),
  positioningRecommendation: arbPositioningRecommendation,
  dimensionsWithNoSource: fc.array(arbResearchDimension),
  verifiedClaimCount: arbNonNegInt,
});

// ---------------------------------------------------------------------------
// Stage 3 — Email sequence
// ---------------------------------------------------------------------------

const arbEmailDraft = (position: 1 | 2 | 3): fc.Arbitrary<EmailDraft> =>
  fc.record({
    position: fc.constant(position),
    subject: arbEdgeString,
    body: arbEdgeString,
    referencedClaimIds: fc.array(arbEdgeString, { minLength: 1 }), // >= 1 (Req 6.2)
    targetedUnknownSlotIds: fc.array(arbEdgeString, { minLength: 1, maxLength: 2 }),
    sendTimingGuidance: arbEdgeString,
    progressionRationale: arbMaybeString,
  });

export const arbEmailSequence: fc.Arbitrary<EmailSequence> = fc.record({
  emails: fc.tuple(arbEmailDraft(1), arbEmailDraft(2), arbEmailDraft(3)),
  coveredUnknownSlotIds: fc.array(arbEdgeString, { minLength: 3, maxLength: 8 }),
  personaAdaptationNote: arbEdgeString,
  researchUnavailableNotice: arbMaybeString,
});

// ---------------------------------------------------------------------------
// Stage 4 — Case studies and matching
// ---------------------------------------------------------------------------

export const arbCaseStudyRecord: fc.Arbitrary<CaseStudyRecord> = fc.record({
  sourceUrl: arbUrl,
  title: arbMaybeString,
  industry: arbMaybeString,
  region: arbMaybeString,
  useCase: arbMaybeString,
  namedPartner: arbMaybeString,
  statedResults: arbMaybeString,
  verificationStatus: arbVerificationStatus,
  retrievedAt: arbMaybeTimestamp,
});

const arbDimensionScore: fc.Arbitrary<DimensionScore> = fc.record({
  dimension: arbRubricDimension,
  weight: arbNumber,
  subScore: arbUnitInterval,
  contribution: arbNumber,
  leadValue: arbMaybeString,
  caseStudyValue: arbMaybeString,
  unknownInput: fc.boolean(),
  reason: arbEdgeString,
});

const arbScoreBreakdown: fc.Arbitrary<ScoreBreakdown> = fc.record({
  dimensions: fc.array(arbDimensionScore),
  matchScore: arbUnitInterval,
});

const arbScoredCaseStudy: fc.Arbitrary<ScoredCaseStudy> = fc.record({
  record: arbCaseStudyRecord,
  breakdown: arbScoreBreakdown,
  rank: arbNonNegInt,
});

export const arbMatchResult: fc.Arbitrary<MatchResult> = fc.record({
  corpusSize: arbNonNegInt,
  rankedCorpus: fc.array(arbScoredCaseStudy),
  winner: arbMaybe(arbScoredCaseStudy),
  runnerUp: arbMaybe(arbScoredCaseStudy),
  comparisonStatement: arbMaybeString,
  decidingDimensions: fc.array(arbRubricDimension),
  rubricWeights: fc.record({
    industry: arbNumber,
    geography: arbNumber,
    useCase: arbNumber,
    partnerOverlap: arbNumber,
  }),
  corpusProvenance: fc.constantFrom(...(["live", "cached", "unavailable"] as const)),
  cachedSnapshotAt: arbMaybeTimestamp,
});

// ---------------------------------------------------------------------------
// Stage 5 — GTM recommendation
// ---------------------------------------------------------------------------

const arbComplexitySignals: fc.Arbitrary<ComplexityAssessment["signals"]> = fc.record({
  siteCount: arbMaybe(arbNumber),
  continuousOperations: fc.boolean(),
  regulatedEnvironment: fc.boolean(),
  multiStakeholder: fc.boolean(),
  dealSizeIndicator: fc.oneof(
    fc.constantFrom(...(["small", "mid", "large"] as const)),
    arbUnknown,
  ),
});

const arbComplexityAssessment: fc.Arbitrary<ComplexityAssessment> = fc.record({
  complexityScore: arbNumber,
  signals: arbComplexitySignals,
  explanation: arbEdgeString,
});

const arbPartnerEvidence: fc.Arbitrary<PartnerEvidence> = fc.record({
  found: fc.boolean(),
  partnerNames: fc.array(arbEdgeString),
  sourceUrl: fc.oneof(arbUrl, arbUnknown),
  supportingQuote: arbMaybeString,
  retrievedAt: arbMaybeTimestamp,
});

export const arbGtmRecommendation: fc.Arbitrary<GtmRecommendation> = fc.record({
  motion: arbGtmMotion,
  reasoning: arbEdgeString,
  geographyConsidered: arbMaybeString,
  complexity: arbComplexityAssessment,
  regionalPartnerEvidence: arbMaybe(arbPartnerEvidence),
  derivedWithoutPartnerEvidence: fc.boolean(),
  partnerType: arbMaybe(arbPartnerType),
  decisionInputsSnapshot: fc.dictionary(
    arbEdgeString,
    fc.oneof(arbEdgeString, arbNumber, fc.boolean()),
  ),
});

/**
 * Raw inputs a GTM decision consumes: geography, complexity signals, and any
 * regional partner evidence. Not a single contract type; assembled from the
 * pieces `GtmRecommendation` is derived from.
 */
export interface GtmDecisionInputs {
  motion: GtmMotion;
  geographyConsidered: Maybe<string>;
  signals: ComplexityAssessment["signals"];
  regionalPartnerEvidence: Maybe<PartnerEvidence>;
}

export const arbGtmDecisionInputs: fc.Arbitrary<GtmDecisionInputs> = fc.record({
  motion: arbGtmMotion,
  geographyConsidered: arbMaybeString,
  signals: arbComplexitySignals,
  regionalPartnerEvidence: arbMaybe(arbPartnerEvidence),
});

// ---------------------------------------------------------------------------
// Stage 6 — Handoff summary
// ---------------------------------------------------------------------------

const arbHandoffFinding: fc.Arbitrary<HandoffFinding> = fc.record({
  claimId: arbMaybeString,
  finding: arbMaybeString,
  sourceUrl: fc.oneof(arbUrl, arbUnknown),
});

export const arbHandoffSummary: fc.Arbitrary<HandoffSummary> = fc.record({
  buyerContext: arbEdgeString,
  qualificationStatus: fc.record({
    framework: arbQualificationFramework,
    priorityScore: arbNonNegInt,
    fitAssessment: arbFitAssessment,
    knownFieldCount: arbNonNegInt,
    unknownSlotLabels: fc.array(arbEdgeString),
  }),
  topThreeFindings: fc.tuple(arbHandoffFinding, arbHandoffFinding, arbHandoffFinding),
  verifiedFindingsAvailable: arbNonNegInt,
  recommendedCaseStudy: fc.record({
    sourceUrl: fc.oneof(arbUrl, arbUnknown),
    title: arbMaybeString,
    whyItWon: arbMaybeString,
  }),
  suggestedNextStep: fc.record({
    action: arbEdgeString,
    rationale: arbEdgeString,
    consistentWithMotion: fc.oneof(arbGtmMotion, arbUnknown),
  }),
});

// ---------------------------------------------------------------------------
// Provenance, events, and artifact
// ---------------------------------------------------------------------------

export const arbFetchLedgerEntry: fc.Arbitrary<FetchLedgerEntry> = fc.record({
  entryId: arbEdgeString,
  runId: arbEdgeString,
  stage: arbStageNumber,
  kind: fc.constantFrom(...(["search", "page_fetch"] as const)),
  requestedUrl: arbUrl,
  finalUrl: fc.oneof(arbUrl, arbUnknown),
  normalizedUrl: arbUrl,
  query: arbMaybeString,
  statusCode: arbMaybe(arbNumber),
  ok: fc.boolean(),
  errorKind: arbMaybe(
    fc.constantFrom(...(["timeout", "network", "http_error", "parse_error"] as const)),
  ),
  retrievedAt: arbIsoTimestamp,
  contentBytes: arbMaybe(arbNumber),
  contentHash: arbMaybeString,
});

/** A fetch ledger: a set of entries that share one `runId`. */
export const arbFetchLedger: fc.Arbitrary<FetchLedgerEntry[]> = fc
  .tuple(arbEdgeString, fc.array(arbFetchLedgerEntry, { maxLength: 10 }))
  .map(([runId, entries]) => entries.map((e) => ({ ...e, runId })));

const arbStageEventType: fc.Arbitrary<StageEventType> = fc.constantFrom(
  ...([
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
  ] as const),
);

export const arbStageEvent: fc.Arbitrary<StageEvent> = fc.record(
  {
    seq: arbNonNegInt,
    eventId: arbEdgeString,
    runId: arbEdgeString,
    stage: fc.oneof(arbStageNumber, fc.constant(null)),
    stageName: fc.oneof(arbEdgeString, fc.constant(null)),
    type: arbStageEventType,
    timestamp: arbIsoTimestamp,
    message: arbEdgeString,
    inputSummary: arbEdgeString,
    toolCall: fc.record({
      kind: fc.constantFrom(...(["search", "page_fetch"] as const)),
      urlOrQuery: arbUrl,
      statusCode: arbMaybe(arbNumber),
      retrievedAt: arbIsoTimestamp,
    }),
    llmCall: fc.record(
      {
        provider: arbEdgeString,
        model: arbEdgeString,
        purpose: arbEdgeString,
        promptTokens: arbMaybe(arbNumber),
        completionTokens: arbMaybe(arbNumber),
        attempt: arbNonNegInt,
        fallbackModelUsed: fc.boolean(),
        throttled: fc.boolean(),
        throttleWaitMs: arbNonNegInt,
        rateLimited: fc.boolean(),
        retryAfterMs: arbMaybe(arbNumber),
      },
      {
        requiredKeys: [
          "provider",
          "model",
          "purpose",
          "promptTokens",
          "completionTokens",
          "attempt",
        ],
      },
    ),
    stageStatus: arbStageStatus,
    output: arbEdgeString,
    rejectedUrl: arbUrl,
    substitutedField: arbEdgeString,
    durationMs: arbNonNegInt,
  },
  {
    requiredKeys: [
      "seq",
      "eventId",
      "runId",
      "stage",
      "stageName",
      "type",
      "timestamp",
      "message",
    ],
  },
);

/** A monotonic per-run event stream: shared `runId`, `seq` increasing from 0. */
export const arbStageEventSequence: fc.Arbitrary<StageEvent[]> = fc
  .tuple(arbEdgeString, fc.array(arbStageEvent, { maxLength: 12 }))
  .map(([runId, events]) =>
    events.map((event, index) => ({ ...event, runId, seq: index })),
  );

const arbStageRecord = <T>(
  stage: StageNumber,
  outputArb: fc.Arbitrary<T>,
): fc.Arbitrary<StageRecord<T>> =>
  fc.record({
    stage: fc.constant(stage),
    stageName: arbEdgeString,
    sourceFile: arbEdgeString,
    status: arbStageStatus,
    attempts: arbNonNegInt,
    startedAt: arbMaybeTimestamp,
    completedAt: arbMaybeTimestamp,
    durationMs: arbMaybe(arbNumber),
    output: fc.oneof(outputArb, arbUnknown),
    failureReason: arbMaybeString,
  });

export const arbRunArtifact: fc.Arbitrary<RunArtifact> = fc.record({
  schemaVersion: fc.constant<1>(1),
  runId: arbEdgeString,
  status: arbRunStatus,
  startedAt: arbIsoTimestamp,
  completedAt: arbMaybeTimestamp,
  leadProfile: arbLeadProfile,
  providerConfig: fc.record({
    llmProvider: arbEdgeString,
    llmModel: arbEdgeString,
    llmFallbackModel: arbMaybeString,
    llmMaxRpm: arbNonNegInt,
    searchProvider: arbEdgeString,
    runStoreBackend: fc.constantFrom(...(["upstash", "json_file"] as const)),
    runStoreDurable: fc.boolean(),
  }),
  stages: fc.record({
    stage1: arbStageRecord(1, arbQualificationResult),
    stage2: arbStageRecord(2, arbResearchReport),
    stage3: arbStageRecord(3, arbEmailSequence),
    stage4: arbStageRecord(4, arbMatchResult),
    stage5: arbStageRecord(5, arbGtmRecommendation),
    stage6: arbStageRecord(6, arbHandoffSummary),
  }),
  events: arbStageEventSequence,
  fetchLedger: arbFetchLedger,
  unknownFieldReport: fc.array(
    fc.record({
      dimension: arbMaybe(arbResearchDimension),
      field: arbEdgeString,
      reason: arbEdgeString,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Throttle schedule (Property 38)
// ---------------------------------------------------------------------------

/**
 * Inputs for the LLM-throttle property: per-call submission offsets (ms from
 * the start of the simulated clock), per-call durations (ms), and an RPM
 * ceiling of one or more. `submissionOffsets` and `durations` share a length
 * so each scheduled call has both.
 */
export interface ThrottleSchedule {
  submissionOffsets: number[];
  durations: number[];
  maxRpm: number;
}

export const arbThrottleSchedule: fc.Arbitrary<ThrottleSchedule> = fc
  .integer({ min: 0, max: 24 })
  .chain((count) =>
    fc.record({
      submissionOffsets: fc.array(fc.integer({ min: 0, max: 180000 }), {
        minLength: count,
        maxLength: count,
      }),
      durations: fc.array(fc.integer({ min: 0, max: 5000 }), {
        minLength: count,
        maxLength: count,
      }),
      maxRpm: fc.integer({ min: 1, max: 120 }), // RPM ceiling >= 1
    }),
  );
