/**
 * Shared contracts for the Inbound BDR Agent (Req 13.5).
 *
 * All shared types live in this single module and are mirrored one-to-one by
 * Zod schemas in `src/agent/schemas.ts`, which are the single source of truth
 * for LLM output validation, route input validation, and store serialization.
 *
 * Two conventions run through every type:
 *  - `Unknown` is a literal string type, not `null`. `type Unknown = "unknown"`
 *    and `type Maybe<T> = T | Unknown`. A literal string survives JSON
 *    serialization, renders directly in the UI, and cannot be confused with
 *    "not yet computed".
 *  - All timestamps are ISO-8601 strings, not `Date` objects, so
 *    serialize/deserialize store round-trips are exact (Req 16.4).
 */

import type { ZodType } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const UNKNOWN = "unknown" as const;
export type Unknown = typeof UNKNOWN;
export type Maybe<T> = T | Unknown;

/** ISO-8601 UTC timestamp string. Kept as a string so store round-trips stay exact. */
export type IsoTimestamp = string;

export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6;
export type StageStatus = "pending" | "running" | "complete" | "failed";
export type RunStatus = "running" | "complete" | "partial" | "failed";
export type VerificationStatus = "verified" | "unknown" | "stale";
export type ResearchDimension =
  | "org_structure"
  | "budget_signals"
  | "recent_news"
  | "leadership_language"
  | "positioning";

// ---------------------------------------------------------------------------
// Lead Input and Profile
// ---------------------------------------------------------------------------

export interface RawEmailRecord {
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  receivedAt?: IsoTimestamp;
  formFields?: Record<string, string>; // arbitrary contact-form extras
}

export interface LeadProfile {
  leadId: string;
  senderName: Maybe<string>;
  senderEmail: Maybe<string>;
  title: Maybe<string>;
  division: Maybe<string>;
  company: Maybe<string>;
  companyDomain: Maybe<string>;
  country: Maybe<string>;
  region: Maybe<string>; // generic country→region map
  industry: Maybe<string>;
  statedUseCase: Maybe<string>;
  statedPainPoints: string[]; // [] when none stated
  referralSource: Maybe<string>; // "Anglo American" for Fixed_Lead (Req 1.5)
  statedTimeline: Maybe<string>; // Q3 budget conversation for Fixed_Lead (Req 1.5)
  siteCount: Maybe<number>;
  rawEmail: RawEmailRecord;
  normalizedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Stage 1 — Qualification
// ---------------------------------------------------------------------------

export type QualificationFramework = "MEDDPICC" | "BANT" | "SPICED";
export type FitAssessment = "strong_fit" | "moderate_fit" | "weak_fit";

export interface FrameworkSlot {
  slotId: string; // e.g. "economicBuyer"
  slotLabel: string; // e.g. "Economic Buyer"
}

export interface KnownField {
  slotId: string;
  slotLabel: string;
  value: string;
  sourceLeadField: keyof LeadProfile; // which LeadProfile field supplied it (Req 3.3)
  evidenceQuote: string; // verbatim span from the lead email
}

export interface UnknownField {
  slotId: string;
  slotLabel: string;
  whyItMatters: string;
}

export interface ScoreFactor {
  factor: string;
  contribution: number; // signed points
  explanation: string;
}

export interface QualificationResult {
  framework: QualificationFramework;
  frameworkSlots: FrameworkSlot[]; // full slot set for the framework
  frameworkSelectionJustification: string;
  justificationLeadAttributes: (keyof LeadProfile)[]; // length >= 2 (Req 3.2)
  knownFields: KnownField[];
  unknownFields: UnknownField[];
  priorityScore: number; // integer 0..100 (Req 3.5)
  scoreFactors: ScoreFactor[]; // (Req 3.6)
  scoreReasoning: string;
  fitAssessment: FitAssessment; // (Req 3.7)
}

// ---------------------------------------------------------------------------
// Stage 2 — Research
// ---------------------------------------------------------------------------

export interface NumericFigure {
  label: string;
  value: string; // kept as string to preserve units/format
  sourceUrl: string; // required (Req 5.6)
}

export interface ResearchClaim {
  claimId: string; // "claim_<dimension>_<n>", referenced by stages 3 and 6
  dimension: ResearchDimension;
  claimText: Maybe<string>; // UNKNOWN when unverified (Req 5.2)
  sourceUrl: Maybe<string>; // ledgered URL when verified (Req 4.7)
  supportingQuote: Maybe<string>; // span from the retrieved page
  retrievedAt: Maybe<IsoTimestamp>; // from the ledger (Req 4.9)
  verificationStatus: VerificationStatus;
  numericFigures: NumericFigure[];
  rejectionReason?: string; // set when provenance check rejected it (Req 5.3)
}

export interface PositioningAssertion {
  assertion: string;
  supportingClaimIds: string[]; // length >= 1 (Req 4.6)
}

export interface PositioningRecommendation {
  narrative: string;
  assertions: PositioningAssertion[];
}

export interface ResearchReport {
  claims: ResearchClaim[];
  claimsByDimension: Record<ResearchDimension, string[]>; // dimension → claimIds
  positioningRecommendation: PositioningRecommendation;
  dimensionsWithNoSource: ResearchDimension[]; // feeds LimitationsPanel (Req 5.7)
  verifiedClaimCount: number;
}

// ---------------------------------------------------------------------------
// Stage 3 — Email Sequence
// ---------------------------------------------------------------------------

export interface EmailDraft {
  position: 1 | 2 | 3;
  subject: string;
  body: string;
  referencedClaimIds: string[]; // length >= 1 (Req 6.2)
  targetedUnknownSlotIds: string[]; // length 1..2 (Req 6.3)
  sendTimingGuidance: string; // e.g. "Day 0", "Day 3"
  progressionRationale: Maybe<string>; // UNKNOWN for position 1 (Req 6.5)
}

export interface EmailSequence {
  emails: [EmailDraft, EmailDraft, EmailDraft]; // exactly 3 (Req 6.1)
  coveredUnknownSlotIds: string[]; // >= 3 distinct (Req 6.4)
  personaAdaptationNote: string; // (Req 6.6)
  researchUnavailableNotice: Maybe<string>; // set per Req 6.7
}

// ---------------------------------------------------------------------------
// Stage 4 — Case Studies and Matching
// ---------------------------------------------------------------------------

export interface CaseStudyRecord {
  sourceUrl: string;
  title: Maybe<string>;
  industry: Maybe<string>;
  region: Maybe<string>;
  useCase: Maybe<string>;
  namedPartner: Maybe<string>;
  statedResults: Maybe<string>;
  verificationStatus: VerificationStatus; // "stale" when from Cached_Corpus (Req 7.6)
  retrievedAt: Maybe<IsoTimestamp>;
}

export type RubricDimension = "industry" | "geography" | "useCase" | "partnerOverlap";

export interface DimensionScore {
  dimension: RubricDimension;
  weight: number; // from RUBRIC_WEIGHTS
  subScore: number; // 0.0..1.0
  contribution: number; // weight * subScore
  leadValue: Maybe<string>; // exactly what was compared (Req 8.1)
  caseStudyValue: Maybe<string>;
  unknownInput: boolean;
  reason: string;
}

export interface ScoreBreakdown {
  dimensions: DimensionScore[]; // one per RubricDimension (Req 8.3)
  matchScore: number; // 0.0..1.0 (Req 8.6)
}

export interface ScoredCaseStudy {
  record: CaseStudyRecord;
  breakdown: ScoreBreakdown;
  rank: number; // 1-based
}

export interface MatchResult {
  corpusSize: number;
  rankedCorpus: ScoredCaseStudy[]; // (Req 8.4)
  winner: Maybe<ScoredCaseStudy>;
  runnerUp: Maybe<ScoredCaseStudy>; // UNKNOWN when corpus < 2 (Req 8.9)
  comparisonStatement: Maybe<string>; // (Req 8.5)
  decidingDimensions: RubricDimension[];
  rubricWeights: Record<RubricDimension, number>;
  corpusProvenance: "live" | "cached" | "unavailable";
  cachedSnapshotAt: Maybe<IsoTimestamp>; // (Req 7.6)
}

// ---------------------------------------------------------------------------
// Stage 5 — GTM Recommendation
// ---------------------------------------------------------------------------

export type GtmMotion = "direct_ae" | "partner_led";

export type PartnerType =
  | "systems_integrator"
  | "drone_service_provider"
  | "hardware_reseller"
  | "industrial_automation_consultancy"
  | Unknown;

export interface PartnerEvidence {
  found: boolean;
  partnerNames: string[];
  sourceUrl: Maybe<string>; // ledgered FlytBase URL (Req 9.4)
  supportingQuote: Maybe<string>;
  retrievedAt: Maybe<IsoTimestamp>;
}

export interface ComplexityAssessment {
  complexityScore: number;
  signals: {
    siteCount: Maybe<number>;
    continuousOperations: boolean;
    regulatedEnvironment: boolean;
    multiStakeholder: boolean;
    dealSizeIndicator: "small" | "mid" | "large" | Unknown;
  };
  explanation: string;
}

export interface GtmRecommendation {
  motion: GtmMotion; // (Req 9.2)
  reasoning: string; // geography + complexity + partner (Req 9.3)
  geographyConsidered: Maybe<string>;
  complexity: ComplexityAssessment;
  regionalPartnerEvidence: Maybe<PartnerEvidence>; // UNKNOWN per Req 9.5
  derivedWithoutPartnerEvidence: boolean; // (Req 9.5)
  partnerType: Maybe<PartnerType>; // required when partner_led (Req 9.4)
  decisionInputsSnapshot: Record<string, string | number | boolean>; // audit trail
}

// ---------------------------------------------------------------------------
// Stage 6 — Handoff Summary
// ---------------------------------------------------------------------------

export interface HandoffFinding {
  claimId: Maybe<string>;
  finding: Maybe<string>;
  sourceUrl: Maybe<string>; // (Req 10.3)
}

export interface HandoffSummary {
  buyerContext: string;
  qualificationStatus: {
    framework: QualificationFramework;
    priorityScore: number;
    fitAssessment: FitAssessment;
    knownFieldCount: number; // (Req 10.2)
    unknownSlotLabels: string[];
  };
  topThreeFindings: [HandoffFinding, HandoffFinding, HandoffFinding]; // (Req 10.3)
  verifiedFindingsAvailable: number; // (Req 10.7)
  recommendedCaseStudy: {
    sourceUrl: Maybe<string>;
    title: Maybe<string>;
    whyItWon: Maybe<string>; // (Req 10.4)
  };
  suggestedNextStep: {
    action: string;
    rationale: string;
    consistentWithMotion: GtmMotion | Unknown; // (Req 10.5)
  };
}

// ---------------------------------------------------------------------------
// Provenance, Events, and Artifact
// ---------------------------------------------------------------------------

export interface FetchLedgerEntry {
  entryId: string;
  runId: string;
  stage: StageNumber;
  kind: "search" | "page_fetch";
  requestedUrl: string; // for search: the provider endpoint
  finalUrl: Maybe<string>; // after redirects
  normalizedUrl: string; // key used by isLedgered()
  query: Maybe<string>; // search query text
  statusCode: Maybe<number>; // UNKNOWN on network error/timeout
  ok: boolean;
  errorKind: Maybe<"timeout" | "network" | "http_error" | "parse_error">;
  retrievedAt: IsoTimestamp;
  contentBytes: Maybe<number>;
  contentHash: Maybe<string>; // sha256 of extracted text
}

export type StageEventType =
  | "run_started"
  | "stage_started"
  | "tool_call"
  | "tool_error"
  | "reasoning"
  | "llm_call"
  | "validation_error"
  | "unknown_substitution"
  | "stage_completed"
  | "stage_failed"
  | "run_completed";

export interface StageEvent {
  seq: number; // monotonic per run; SSE dedupe key
  eventId: string;
  runId: string;
  stage: StageNumber | null; // null for run-level events
  stageName: string | null;
  type: StageEventType;
  timestamp: IsoTimestamp;
  message: string;
  inputSummary?: string; // (Req 11.1)
  toolCall?: {
    // (Req 11.2)
    kind: "search" | "page_fetch";
    urlOrQuery: string;
    statusCode: Maybe<number>;
    retrievedAt: IsoTimestamp;
  };
  llmCall?: {
    provider: string;
    model: string; // the model that actually served the call
    purpose: string;
    promptTokens: Maybe<number>;
    completionTokens: Maybe<number>;
    attempt: number;
    fallbackModelUsed?: boolean; // true when OPENROUTER_FALLBACK_MODEL served it
    throttled?: boolean; // true when the call waited on the RPM queue
    throttleWaitMs?: number;
    rateLimited?: boolean; // true when a 429 forced a backoff
    retryAfterMs?: Maybe<number>; // honored Retry-After, UNKNOWN when absent
  };
  stageStatus?: StageStatus;
  output?: unknown; // complete stage output on stage_completed (Req 11.3)
  rejectedUrl?: string; // on validation_error (Req 5.3)
  substitutedField?: string; // on unknown_substitution (Req 17.5)
  durationMs?: number;
}

export interface StageRecord<T> {
  stage: StageNumber;
  stageName: string;
  sourceFile: string; // e.g. "src/agent/stages/stage-1-qualifier.ts" (Req 13.1)
  status: StageStatus;
  attempts: number;
  startedAt: Maybe<IsoTimestamp>;
  completedAt: Maybe<IsoTimestamp>;
  durationMs: Maybe<number>;
  output: T | Unknown; // UNKNOWN when the stage failed (Req 2.5)
  failureReason: Maybe<string>;
}

export interface RunArtifact {
  schemaVersion: 1;
  runId: string;
  status: RunStatus;
  startedAt: IsoTimestamp;
  completedAt: Maybe<IsoTimestamp>;
  leadProfile: LeadProfile;
  providerConfig: {
    // names only, never keys (Req 14.5)
    llmProvider: string; // includes "openrouter"
    llmModel: string;
    llmFallbackModel: Maybe<string>;
    llmMaxRpm: number;
    searchProvider: string;
    runStoreBackend: "upstash" | "json_file";
    runStoreDurable: boolean;
  };
  stages: {
    stage1: StageRecord<QualificationResult>;
    stage2: StageRecord<ResearchReport>;
    stage3: StageRecord<EmailSequence>;
    stage4: StageRecord<MatchResult>;
    stage5: StageRecord<GtmRecommendation>;
    stage6: StageRecord<HandoffSummary>;
  };
  events: StageEvent[]; // (Req 11.6)
  fetchLedger: FetchLedgerEntry[]; // (Req 5.4)
  unknownFieldReport: {
    // (Req 5.7)
    dimension: Maybe<ResearchDimension>;
    field: string;
    reason: string;
  }[];
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  company: Maybe<string>;
  startedAt: IsoTimestamp;
  verifiedClaimCount: number;
}

// ---------------------------------------------------------------------------
// Stage Module Interface (Req 13.5)
// ---------------------------------------------------------------------------

export interface StageContext {
  runId: string;
  leadProfile: LeadProfile;
  toolbelt: ResearchToolbelt;
  llm: LlmProvider;
  emit: (event: Omit<StageEvent, "seq" | "eventId" | "runId" | "timestamp">) => void;
  attempt: number; // 1..3 (Req 17.4)
  validationFeedback?: string; // populated on retry
  upstream: {
    qualification?: QualificationResult | Unknown;
    research?: ResearchReport | Unknown;
    emails?: EmailSequence | Unknown;
    match?: MatchResult | Unknown;
    gtm?: GtmRecommendation | Unknown;
  };
}

export interface Stage<TOutput> {
  readonly stage: StageNumber;
  readonly stageName: string;
  readonly sourceFile: string; // self-declared, surfaced in UI (Req 13.1)
  readonly dependsOn: readonly (keyof StageContext["upstream"])[];
  readonly usesToolbelt: boolean;
  readonly schema: ZodType<TOutput>; // validated by orchestrator (Req 17.4)
  run(ctx: StageContext): Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// LLM Call Throttle (src/providers/llm/throttle.ts)
// ---------------------------------------------------------------------------

export interface ThrottleEvent {
  purpose: string;
  waitMs: number; // how long the call waited on the RPM queue
  windowStartsInFlight: number; // starts inside the trailing 60s window
  maxRpm: number;
}

export interface LlmThrottle {
  /** Queues fn and runs it when a request slot is free. Preserves submission order. */
  schedule<T>(purpose: string, fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Research Toolbelt
// ---------------------------------------------------------------------------

export interface ResearchToolbelt {
  search(query: string, opts?: { maxResults?: number }): Promise<SearchHit[]>;
  fetchPage(url: string): Promise<FetchedPage | null>;
  getLedger(): readonly FetchLedgerEntry[];
  isLedgered(url: string): boolean;
}

// ---------------------------------------------------------------------------
// Provider Interfaces
// ---------------------------------------------------------------------------

export interface LlmProvider {
  readonly name: "openai" | "anthropic" | "gemini" | "openrouter";
  readonly model: string; // primary model slug
  readonly fallbackModel: Maybe<string>; // UNKNOWN when none configured
  /** Returns a value already validated against `schema`; throws LlmValidationError otherwise. */
  completeJson<T>(args: {
    purpose: string;
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
    maxOutputTokens?: number;
    temperature?: number;
    useFallbackModel?: boolean; // set by the orchestrator on the final attempt
  }): Promise<{
    value: T;
    modelUsed: string; // primary or fallback, recorded in the trace
    usage: { promptTokens: Maybe<number>; completionTokens: Maybe<number> };
  }>;
}

/** Construction parameters. `openai` and `openrouter` share one implementation. */
export interface OpenAiCompatibleConfig {
  name: "openai" | "openrouter";
  baseUrl: string; // https://openrouter.ai/api/v1 for openrouter
  apiKey: string;
  model: string;
  fallbackModel: Maybe<string>;
  extraHeaders?: Record<string, string>; // HTTP-Referer / X-Title — attribution only
}

export interface SearchHit {
  url: string;
  title: Maybe<string>;
  snippet: Maybe<string>;
  publishedDate: Maybe<string>;
}

export interface SearchProvider {
  readonly name: "tavily" | "exa" | "serper";
  search(query: string, opts?: { maxResults?: number; site?: string }): Promise<SearchHit[]>;
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  text: string; // extracted readable text
  retrievedAt: IsoTimestamp;
  fromCache: boolean; // true → claims marked "stale"
}
