# Implementation Plan: Inbound BDR Agent

## Overview

Build the Next.js 15 (App Router) TypeScript application bottom-up: shared contracts and Zod schemas first, then the provider adapters and the Research Toolbelt with its fetch ledger, then the orchestrator with its provenance and degradation controls, then the six stage modules in order, then persistence, the SSE route, and the Run Console UI, finishing with repository hygiene checks and full-pipeline wiring.

Sequencing rationale: the fetch ledger and the provenance filter land before Stage 2 so that no claim-producing code can ever exist without the anti-fabrication check in place. The pure deterministic cores (slot partition, serializer, scoring rubric, GTM decision) are built before the stage modules that call them, because those cores carry the correctness properties.

Language: TypeScript (as specified in the design document).

## Tasks

- [x] 1. Project scaffolding, shared contracts, and configuration
  - [x] 1.1 Scaffold the Next.js 15 TypeScript project and test tooling
    - Initialize the App Router project with the `src/` layout from the design's Repository Layout section
    - Add Vitest, fast-check, and React Testing Library with a `test` script and a `--run` (non-watch) default
    - Create `.gitignore` covering `.env`, `.env.local`, `.env.*.local`, and `.data/`
    - Create `.env.example` listing `LLM_PROVIDER`, `SEARCH_PROVIDER`, each provider key, the Upstash pair, `CRAWL_MAX_PAGES`, and `REQUEST_TIMEOUT_MS`, each with a placeholder and one-line description
    - Also list the OpenRouter and throttle variables: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `google/gemma-4-31b-it:free`), `OPENROUTER_FALLBACK_MODEL` (default `google/gemma-4-26b-a4b-it:free`), `OPENROUTER_APP_URL`, `OPENROUTER_APP_TITLE`, and `LLM_MAX_RPM` (default `20`)
    - _Requirements: 14.2, 14.3, 15.1_

  - [x] 1.2 Implement the shared contracts module
    - Create `src/agent/contracts.ts` with `UNKNOWN`/`Unknown`/`Maybe<T>`, `IsoTimestamp`, status unions, `RawEmailRecord`, `LeadProfile`, all six stage output types, `FetchLedgerEntry`, `StageEvent`, `StageRecord`, `RunArtifact`, `RunSummary`, `Stage<TOutput>`, `StageContext`, and the provider interfaces
    - `StageEvent.llmCall` carries `provider`, `model` (the model that actually served the call), `fallbackModelUsed`, `throttled`, `throttleWaitMs`, `rateLimited`, and `retryAfterMs` (`Maybe<number>`, `"unknown"` when absent); add `LlmThrottle` and `ThrottleEvent`
    - `RunArtifact.providerConfig` carries `llmFallbackModel` (`Maybe<string>`) and `llmMaxRpm` alongside the existing name-only fields
    - Keep every timestamp an ISO-8601 string so store round-trips stay exact
    - _Requirements: 13.5, 14.5_

  - [x] 1.3 Implement Zod schemas mirroring the contracts
    - Create `src/agent/schemas.ts` with one schema per contract type, used for LLM output validation, route input validation, and store serialization
    - Enforce literal shapes in the schema: exactly three emails, `priorityScore` integer 0..100, `matchScore` in [0,1], framework enum
    - Mirror the new `llmCall` fields (`fallbackModelUsed`, `throttled`, `throttleWaitMs`, `rateLimited`, `retryAfterMs`) and the new `providerConfig` fields (`llmFallbackModel`, `llmMaxRpm`) so events and artifacts round-trip through the store unchanged
    - _Requirements: 13.5, 17.4_

  - [x] 1.4 Implement the environment configuration module
    - Create `src/lib/config/env.ts` that parses `process.env` through a Zod schema, resolves selector vars first, then requires only the selected provider's key
    - Fail fast on an unknown selector value listing legal values; expose a typed config object as the only config access path; no `NEXT_PUBLIC_` secret names
    - Add `OPENROUTER_API_KEY` (required only when `LLM_PROVIDER=openrouter`, and requiring nothing from OpenAI/Anthropic/Gemini), `OPENROUTER_MODEL` (default `google/gemma-4-31b-it:free`), `OPENROUTER_FALLBACK_MODEL` (default `google/gemma-4-26b-a4b-it:free`), the optional attribution vars `OPENROUTER_APP_URL` and `OPENROUTER_APP_TITLE`, and `LLM_MAX_RPM` (default `20`)
    - _Requirements: 14.1, 14.6_

  - [x] 1.5 Implement test-time network and LLM isolation
    - Make the design's Mocking Boundaries rule enforced by code rather than convention: no test may reach the network or a live model, so the free-tier quota can never be consumed by a test run
    - A Vitest global setup file `tests/setup/no-live-calls.ts`, registered via `setupFiles` in the Vitest config, that replaces global `fetch` with a stub which THROWS a clearly-worded error naming the attempted URL, so an accidental egress fails loudly instead of silently spending quota
    - A shared `createStubLlmProvider(...)` helper in `tests/support/stub-llm.ts` implementing the full `LlmProvider` interface — `name`, `model`, `fallbackModel`, and `completeJson` returning caller-supplied or generated schema-valid values plus `modelUsed` and `usage`; every property, unit, and component test obtains its LLM through this helper and no test constructs a real adapter
    - A stub `SearchProvider` and a stub page-fetch transport in the same helper module, so toolbelt tests exercise the REAL toolbelt and the REAL fetch ledger with only the transport stubbed, preserving the design's boundary that provenance tests run against the production ledger implementation
    - The opt-in live integration tests (task 20.3) are the ONLY tests permitted real egress: they explicitly opt out of the fetch guard, stay gated behind their env flag, and default to skipped
    - _Requirements: 13.4, 17.4_

  - [x] 1.6 Write tests asserting the isolation guard holds
    - Assert that calling `fetch` inside a guarded test throws the guard error and that the message names the attempted URL
    - Static assertion that no file under `tests/` outside the opt-in live integration directory imports a real provider adapter module (`src/providers/llm/*`, `src/providers/search/*`)
    - _Requirements: 13.4, 17.4_

  - [x] 1.7 Create shared fast-check arbitraries
    - `tests/properties/arbitraries.ts` with `arbRawEmail`, `arbLeadProfile`, `arbCaseStudyRecord`, `arbResearchClaim`, `arbFetchLedger`, `arbRunArtifact`, `arbStageEventSequence`, `arbGtmDecisionInputs`, `arbThrottleSchedule` (submission offsets, per-call durations, and RPM ceilings ≥1, for Property 38)
    - Generate the called-out edge cases: `"unknown"` in every field position, empty strings, unicode (CJK/emoji), embedded newlines and delimiter characters, very long strings, adversarial URL shapes
    - _Requirements: 13.5_

  - [x] 1.8 Write unit tests for env parsing and `.env.example` parity
    - Assert the `.env.example` key set equals the env schema key set
    - Assert an unknown selector value fails fast with the legal values listed
    - _Requirements: 14.1, 14.3_

- [x] 2. Providers and Research Toolbelt
  - [x] 2.1 Implement the LLM provider adapters
    - `src/providers/llm/{index.ts,openai.ts,anthropic.ts,gemini.ts}` implementing `completeJson` with schema validation at the boundary and a typed `LlmValidationError`
    - **`openrouter` is a fourth selector value, not a fourth adapter — create NO new adapter file.** Parameterize `openai.ts` by `{ baseUrl, apiKey, model, extraHeaders }` and have the factory in `index.ts` construct it twice: `openai` with the SDK default `https://api.openai.com/v1` + `OPENAI_API_KEY` + no extra headers, and `openrouter` with `https://openrouter.ai/api/v1` + `OPENROUTER_API_KEY` + the optional `HTTP-Referer` (`OPENROUTER_APP_URL`) and `X-Title` (`OPENROUTER_APP_TITLE`) attribution headers, which carry no secret and whose absence changes no behavior
    - The adapter's `name` is the selector value, so an OpenRouter-configured run reports `"openrouter"` (not `"openai"`) in `providerConfig.llmProvider`
    - Fallback-model path: `completeJson` accepts a `useFallbackModel` flag that the orchestrator sets **only on a stage's final attempt**, and returns `modelUsed` so the trace records which model actually served the call; the fallback attempt counts **inside** the existing three-attempt budget and never extends it
    - Wrap every adapter's outbound transport call in `throttle.schedule(...)` (task 2.7) so the per-minute ceiling is enforced at one chokepoint for all providers
    - Rate-limit handling: on a 429/rate-limit response honor `Retry-After` (seconds and HTTP-date forms) **before** entering the existing exponential backoff; an absent or unparseable header falls straight through to backoff; two retries, then surface as a validation failure to the caller
    - Emit `llm_call` StageEvents carrying `throttled`/`throttleWaitMs`, `rateLimited`/`retryAfterMs`, `fallbackModelUsed`, and the serving `model`
    - Return usage token counts as `Maybe<number>`
    - _Requirements: 13.5, 14.1, 14.5, 17.4_

  - [x] 2.2 Implement the search provider adapters
    - `src/providers/search/{index.ts,tavily.ts,exa.ts,serper.ts}` implementing `SearchProvider.search` with `maxResults` and `site` options
    - Selection by `SEARCH_PROVIDER` through the config module only
    - _Requirements: 13.5_

  - [x] 2.3 Implement the fetch ledger
    - `src/research/fetch-ledger.ts`: per-run append-only entry array, `appendEntry`, `isLedgered(url)`, `getLedger()`
    - URL normalization before comparison: lowercase scheme/host, strip default port, trailing slash, fragment, and tracking query params
    - Record redirects as separate entries for requested and final URL; a non-2xx ledgered URL must not satisfy `isLedgered` success checks
    - _Requirements: 5.3, 5.4_

  - [x] 2.4 Implement the Research Toolbelt
    - `src/research/toolbelt.ts` as the sole web egress: `search`, `fetchPage`, `getLedger`, `isLedgered`
    - `AbortController` timeout at `REQUEST_TIMEOUT_MS`; non-success status and network/timeout errors return empty/null instead of throwing, after appending a ledger entry and emitting a `tool_call`/`tool_error` event
    - HTML → readable text (strip script/style/nav), truncate to a token budget; politeness delay and per-run request cap
    - _Requirements: 11.2, 13.3, 13.4, 17.1, 17.2_

  - [x] 2.5 Write property test for the fetch ledger
    - **Property 12: The fetch ledger records every request the toolbelt made**
    - **Validates: Requirements 5.4, 7.8**

  - [x] 2.6 Write property test for toolbelt degradation
    - **Property 35: The toolbelt degrades instead of throwing**
    - **Validates: Requirements 17.1, 17.2**

  - [x] 2.7 Implement the LLM call throttle
    - `src/providers/llm/throttle.ts` exporting `createLlmThrottle({ maxRpm, now, sleep, emit })` returning an `LlmThrottle` with `schedule<T>(purpose, fn)`
    - FIFO queue over a sliding 60-second window of call **start** timestamps: release a call only when fewer than `LLM_MAX_RPM` (default 20) starts fall inside the trailing window, otherwise wait until the oldest start ages out; submission order is preserved so Stage 4's page loop degrades into a slower loop instead of a burst of 429s
    - Inject `now` and `sleep` as parameters so the queue is testable against a simulated clock; call the `emit` hook when a call waits, with the wait duration
    - **This is separate from the Research Toolbelt's web-fetch politeness delay**: the throttle governs *model calls*, the toolbelt delay governs *HTTP egress* to pages and search APIs — separate counters, separate budgets, neither substitutes for the other
    - Rate-limit exhaustion (daily cap, for instance) degrades exactly like any other LLM failure — stage `failed`, output `"unknown"`, run `partial`, no placeholder and no new failure mode
    - Build this before wiring task 2.1's transport wrapping
    - _Requirements: 17.4, 17.6_

  - [x] 2.8 Write property test for the LLM throttle
    - **Property 38: The LLM throttle never exceeds the configured per-minute ceiling**
    - **Validates: Requirements 17.4**
    - Drive `arbThrottleSchedule` against a simulated clock; assert no rolling 60-second window contains more than `LLM_MAX_RPM` starts, every call runs exactly once in submission order, and every waiting call emits a `throttled` event with its wait

  - [x] 2.9 Write unit tests for `Retry-After` parsing
    - Delay-seconds form, HTTP-date form, and the unparseable/absent case falling through to exponential backoff
    - _Requirements: 17.4_

  - [x] 2.10 Write unit test for the OpenAI-compatible adapter parameterization
    - Selecting `openrouter` yields the OpenRouter base URL, the OpenRouter key, and both attribution headers, and requires no OpenAI key; the adapter's `name` reports `"openrouter"`
    - _Requirements: 14.1, 14.5_

- [x] 3. Lead input and normalization
  - [x] 3.1 Implement the fixed lead constant
    - `src/agent/fixed-lead.ts` holding the Rodrigo Castillo / SQM raw email record as the only hardcoded lead data in the repository
    - _Requirements: 1.1_

  - [x] 3.2 Implement the lead normalizer
    - `src/agent/lead-normalizer.ts`: raw email record → `LeadProfile`, every unresolvable field set to `"unknown"`, `rawEmail` preserved verbatim
    - Derive `region` from a generic country→region map and `siteCount` from stated use case text; set `referralSource` and `statedTimeline` from the email body
    - _Requirements: 1.3, 1.4, 1.5_

  - [x] 3.3 Write property test for lead normalization
    - **Property 1: Lead normalization is total and lossless**
    - **Validates: Requirements 1.3, 1.4**

  - [x] 3.4 Write unit tests for the fixed lead and alternative email paths
    - Assert the normalized fixed lead carries referral source `Anglo American` and the Q3 budget-conversation timeline
    - Assert an arbitrary alternative raw email record normalizes through the same interface
    - _Requirements: 1.5, 1.6_

- [x] 4. Orchestrator sequencing, retry, degradation, and events
  - [x] 4.1 Implement the orchestrator run loop
    - `src/agent/orchestrator.ts`: `runPipeline(options)`, ULID-based `runId`, the literal `STAGES` array in order 1→6, `StageContext` construction that supplies exactly each stage's declared `dependsOn` upstream outputs
    - Resolve the lead as `rawEmail ?? FIXED_LEAD`
    - _Requirements: 1.2, 2.1, 2.3, 2.6, 13.2_

  - [x] 4.2 Implement contract validation with bounded retry
    - Validate each stage output against its Zod schema; on failure re-invoke the stage with the validation error in `validationFeedback`, at most two retries, then mark the stage `failed`
    - The **final** attempt switches to `OPENROUTER_FALLBACK_MODEL` when one is configured, by setting `useFallbackModel` on that attempt only; this does not extend the retry budget (still three invocations total, so Property 36 holds unchanged)
    - Emit an `llm_call` event with `fallbackModelUsed: true` and the serving `model` when the fallback serves the attempt; if it also fails validation the stage is `failed` with output `"unknown"`
    - _Requirements: 17.4_

  - [x] 4.3 Implement per-stage failure handling and run status
    - Try/catch per stage; on failure set `StageRecord.status = "failed"` and `output = "unknown"`, continue downstream with the unknown upstream value
    - Run status `complete` when no stage failed, `partial` when any did, `failed` on pre-stage env validation failure
    - Reject any placeholder/illustrative value: only `"unknown"` is substituted
    - _Requirements: 2.4, 2.5, 17.5, 17.6_

  - [x] 4.4 Implement event emission, sequencing, redaction, and run-start env validation
    - Monotonic `seq` per run; fan every `StageEvent` out to both the SSE sink and the artifact event array
    - Emit `stage_started` with stage name, run id, timestamp, input summary; `stage_completed`/`stage_failed` with status and complete output
    - Run `redactSecrets` over every event before emission and over the artifact before persistence
    - Validate required env vars as the first action; on a missing variable emit a `validation_error` naming the variable (name only) and mark the run `failed`
    - _Requirements: 11.1, 11.3, 11.6, 14.4, 14.5_

  - [x] 4.5 Write property test for dependency passing
    - **Property 2: Stages receive exactly their declared dependencies**
    - **Validates: Requirements 2.3**

  - [x] 4.6 Write property test for failure continuation
    - **Property 3: Run status and continuation under arbitrary stage failures**
    - **Validates: Requirements 2.1, 2.4, 2.5**

  - [x] 4.7 Write property test for bounded retry
    - **Property 36: Stage retries are bounded at three attempts**
    - **Validates: Requirements 17.4**

  - [x] 4.8 Write property test for event trace completeness
    - **Property 29: The event trace covers every stage and every tool call**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.6**

  - [x] 4.9 Write property test for missing environment variables
    - **Property 32: Missing environment variables fail the run by name**
    - **Validates: Requirements 14.4**

  - [x] 4.10 Write property test for secret containment
    - **Property 33: Secrets never leave the server**
    - **Validates: Requirements 14.5, 14.6**

- [x] 5. Provenance enforcement and unknown reporting
  - [x] 5.1 Implement the provenance filter
    - Cross-check every claim `sourceUrl`, every `NumericFigure.sourceUrl`, Stage 4 `caseStudy.sourceUrl`, and Stage 5 `partnerEvidenceUrl` against the ledger with a success status
    - Accepted claims take `retrievedAt` from the ledger entry, never from the model; rejected claims get `claimText = "unknown"`, `verificationStatus = "unknown"`, a `rejectionReason`, and a `validation_error` event naming the rejected URL
    - Drop numeric figures lacking a ledgered success URL
    - _Requirements: 4.7, 4.9, 5.1, 5.2, 5.3, 5.6_

  - [x] 5.2 Implement the unknown-field report builder
    - Walk every stage output and collect each field whose value is exactly `"unknown"` into `RunArtifact.unknownFieldReport` with dimension, field path, and reason
    - Emit one `unknown_substitution` event per reported substitution
    - _Requirements: 5.7, 17.5_

  - [x] 5.3 Write property test for provenance enforcement
    - **Property 11: Verified status holds if and only if the source URL is in the run's fetch ledger with a success status**
    - **Validates: Requirements 4.7, 4.9, 5.1, 5.2, 5.3**

  - [x] 5.4 Write property test for numeric figure provenance
    - **Property 13: Numeric figures carry their own source URL**
    - **Validates: Requirements 5.6**

  - [x] 5.5 Write property test for the unknown-field report
    - **Property 14: The unknown-field report is exactly the set of unknown values**
    - **Validates: Requirements 5.7, 17.5**

- [ ] 6. Checkpoint - core pipeline plumbing
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Stage 1 Qualifier
  - [x] 7.1 Implement the framework slot tables and slot partition
    - `src/agent/stages/stage-1/framework-slots.ts`: static slot sets for MEDDPICC, BANT, and SPICED
    - Pure `partitionSlots(framework, knownSlotIds)` computing `unknownFields = ALL_SLOTS − known` by set difference, deduping and discarding slot ids not belonging to the framework
    - _Requirements: 3.4, 3.8_

  - [x] 7.2 Implement the Stage 1 qualifier module
    - `src/agent/stages/stage-1-qualifier.ts`: one schema-constrained LLM call selecting exactly one framework with a justification naming ≥2 `LeadProfile` attributes
    - Validate known fields against the lead (`sourceLeadField` not `"unknown"`, `evidenceQuote` present in the lead text); clamp `priorityScore` to 0..100; derive `fitAssessment` from the score bands; require every score factor name to appear in `scoreReasoning`
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 3.7_

  - [x] 7.3 Write property test for slot coverage
    - **Property 4: Framework slot coverage is an exact partition**
    - **Validates: Requirements 3.4, 3.8**

  - [x] 7.4 Write property test for framework justification
    - **Property 5: Framework justification requires two distinct lead attributes**
    - **Validates: Requirements 3.2**

  - [x] 7.5 Write property test for known-field grounding
    - **Property 6: Known fields are grounded in the lead**
    - **Validates: Requirements 3.3**

  - [x] 7.6 Write property test for priority score bounds and bands
    - **Property 7: Priority score is bounded, explained, and band-consistent**
    - **Validates: Requirements 3.5, 3.6, 3.7**

  - [x] 7.7 Write unit test for single-framework selection
    - Assert the stage output schema accepts only one of `MEDDPICC`, `BANT`, `SPICED`
    - _Requirements: 3.1_

- [x] 8. Stage 2 Researcher
  - [x] 8.1 Implement the dimension retrieval loop
    - `src/agent/stages/stage-2-researcher.ts`: attribute-interpolated query templates built from `LeadProfile` fields only, covering `org_structure`, `budget_signals`, `recent_news`, `leadership_language`
    - At least one toolbelt search or fetch per dimension; fetch the top N (3) hits per dimension; queries target reporting lines, investor-relations/annual-report capex figures, regional automation and safety announcements, and investor/earnings language
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 8.2 Implement claim extraction, unknown fallback, and positioning synthesis
    - One extraction LLM call per dimension whose prompt contains only retrieved text plus its URL, requiring a `supportingQuote` span and a `numericFigures[]` list
    - Dimensions with zero retrieved text yield exactly one claim with `claimText: "unknown"` and `verificationStatus: "unknown"`, recorded in `dimensionsWithNoSource`
    - Synthesize `positioningRecommendation`, dropping any assertion without ≥1 resolvable `supportingClaimIds`
    - _Requirements: 4.6, 4.8, 4.9_

  - [x] 8.3 Write property test for dimension attempt coverage
    - **Property 8: Every required research dimension is attempted**
    - **Validates: Requirements 4.1**

  - [x] 8.4 Write property test for unsupported dimensions
    - **Property 9: Unsupported dimensions yield exactly one unknown claim**
    - **Validates: Requirements 4.8**

  - [x] 8.5 Write property test for positioning assertions
    - **Property 10: Positioning assertions resolve to real claims**
    - **Validates: Requirements 4.6**

  - [x] 8.6 Write unit tests for dimension content and total search failure
    - With mocked retrieval, assert org-structure, budget-signal, news, and leadership-language claims are produced for their dimensions
    - Assert an all-requests-fail run yields only `"unknown"` claims and a `partial` run
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 17.3_

- [x] 9. Stage 3 Responder
  - [x] 9.1 Implement the unknown-slot coverage planner
    - `src/agent/stages/stage-3/slot-plan.ts`: deterministic partition of `qualification.unknownFields` across three emails, 1–2 slots each, greedily prioritizing economic buyer, decision process, and metrics, guaranteeing ≥3 distinct slots when ≥3 are available
    - _Requirements: 6.3, 6.4_

  - [x] 9.2 Implement the Stage 3 responder module
    - `src/agent/stages/stage-3-responder.ts`: one generation call producing exactly three drafts with subject, body, `sendTimingGuidance`, and the pre-assigned `targetedUnknownSlotIds`
    - Validate ≥1 resolvable `referencedClaimIds` per draft; require `progressionRationale` on drafts 2 and 3 and `"unknown"` on draft 1; emit `personaAdaptationNote`
    - Zero verified claims → lead-facts-only prompt, no claim references, `researchUnavailableNotice` set
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.7_

  - [x] 9.3 Write property test for the email sequence contract
    - **Property 16: The email sequence satisfies its structural contract**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

  - [x] 9.4 Write property test for the research-unavailable path
    - **Property 17: Zero verified research degrades the sequence honestly**
    - **Validates: Requirements 6.7**

  - [x] 9.5 Write unit test for the persona adaptation note
    - Assert the note states the tone and technical-depth adjustment for an operations-leader persona
    - _Requirements: 6.6_

- [ ] 10. Checkpoint - stages 1 through 3
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Stage 4 case-study discovery
  - [x] 11.1 Implement the case-study serializer
    - `src/agent/stages/stage-4/case-study-serializer.ts`: canonical fixed-field-order serialization with `"unknown"` for absent values, plus a matching parser, with delimiter escaping so embedded delimiters and newlines survive
    - _Requirements: 7.4, 7.5_

  - [x] 11.2 Write property test for serializer round-trip
    - **Property 20: Case-study serialization round-trips**
    - **Validates: Requirements 7.4, 7.5**

  - [x] 11.3 Implement case-study URL enumeration
    - `src/agent/stages/stage-4/case-study-extractor.ts`: fetch the FlytBase case-studies index through the toolbelt, extract anchor hrefs, resolve relative and protocol-relative URLs, filter to same-origin case-study paths, dedupe after normalization, cap at `CRAWL_MAX_PAGES`, never throw on malformed markup
    - _Requirements: 7.1_

  - [x] 11.4 Implement per-page case-study extraction
    - Fetch each enumerated page and run one LLM extraction into a `CaseStudyRecord` with all seven fields, `"unknown"` for absent fields, `retrievedAt` from the ledger
    - Emit a StageEvent carrying the retrieved URL and response status for every page request
    - _Requirements: 7.2, 7.3, 7.8_

  - [x] 11.5 Write property test for URL enumeration safety
    - **Property 18: Case-study URL enumeration is safe and same-origin**
    - **Validates: Requirements 7.1**

  - [x] 11.6 Write property test for extraction totality
    - **Property 19: Case-study extraction is total**
    - **Validates: Requirements 7.2, 7.3**

  - [x] 11.7 Implement the cached-corpus fallback chain
    - Add `src/research/cached-corpus/` with a committed snapshot and `manifest.json` carrying a snapshot timestamp
    - Live index failure → load the snapshot, set every affected record `verificationStatus: "stale"`, emit a StageEvent with the snapshot timestamp
    - Live failure with no snapshot available → stage status `failed` and `matchResult` set to `"unknown"`
    - _Requirements: 7.6, 7.7_

  - [x] 11.8 Write unit tests for the fallback branches
    - Assert the cached path marks records `stale` and emits the snapshot timestamp
    - Assert the no-cache path fails the stage with `matchResult` `"unknown"`
    - _Requirements: 7.6, 7.7_

- [x] 12. Stage 4 attribute-driven matching
  - [x] 12.1 Implement the scoring rubric
    - `src/agent/stages/stage-4/scoring-rubric.ts`: `RUBRIC_WEIGHTS` (industry 0.35, geography 0.25, useCase 0.30, partnerOverlap 0.10) and one pure sub-score function per dimension comparing a `LeadProfile` field to a `CaseStudyRecord` field
    - Generic industry taxonomy and country→region tables; `"unknown"` on either side scores 0.0 with `unknownInput: true`; clamp each sub-score to [0,1]; round the weighted sum to 4 decimals and re-clamp
    - No string literal naming a company, person, email address, or referral organization anywhere in the file
    - _Requirements: 8.1, 8.2, 8.6, 8.8_

  - [x] 12.2 Implement ranking and match-result assembly
    - `src/agent/stages/stage-4/ranking.ts`: score every record, rank 1..n in non-increasing score order, select winner and runner-up, compute `decidingDimensions` where the winner's weighted contribution strictly exceeds the runner-up's, and build the comparison statement
    - Corpus size < 2 → emit available records, runner-up `"unknown"`, and a corpus-size StageEvent
    - _Requirements: 8.3, 8.4, 8.5, 8.9_

  - [x] 12.3 Implement the Stage 4 matcher module
    - `src/agent/stages/stage-4-matcher.ts`: wire extractor → rubric → ranking, populate `corpusProvenance`, `cachedSnapshotAt`, `rubricWeights`, and the per-dimension breakdown for winner and runner-up
    - _Requirements: 8.2, 8.3, 8.4_

  - [x] 12.4 Write property test for score bounds
    - **Property 21: Match scores are bounded and equal their weighted sum**
    - **Validates: Requirements 8.2, 8.6**

  - [x] 12.5 Write property test for scoring purity
    - **Property 22: Scoring is a pure function of lead and case-study fields**
    - **Validates: Requirements 8.1**

  - [x] 12.6 Write property test for ranking consistency
    - **Property 23: Ranking is consistent and lossless**
    - **Validates: Requirements 8.3, 8.4, 8.5, 8.9**

  - [x] 12.7 Write property test for attribute sensitivity
    - **Property 24: Scoring is sensitive to lead industry and geography**
    - **Validates: Requirements 8.7**

- [x] 13. Stage 5 GTM Advisor
  - [x] 13.1 Implement the GTM decision function
    - `src/agent/stages/stage-5/gtm-decision.ts`: pure `decideGtmMotion(inputs)` computing the complexity score and the `direct_ae` / `partner_led` motion from typed attribute and evidence inputs only
    - Classify `partnerType` by generic vocabulary hit counts over retrieved partner text, `"unknown"` on a tie or zero hits; no company, person, or referral-organization literals
    - _Requirements: 9.2, 9.6_

  - [x] 13.2 Implement the Stage 5 advisor module
    - `src/agent/stages/stage-5-gtm-advisor.ts`: geography-interpolated toolbelt search against FlytBase public material, then narrate the already-decided motion referencing geography, complexity, and partner evidence presence or absence
    - `partner_led` requires `partnerType` and a ledgered supporting `sourceUrl`; no partner signal → `regionalPartnerEvidence: "unknown"` and `derivedWithoutPartnerEvidence: true`
    - Populate `decisionInputsSnapshot` as the audit trail
    - _Requirements: 9.1, 9.3, 9.4, 9.5_

  - [x] 13.3 Write property test for the partner-material query
    - **Property 25: Every GTM run queries FlytBase partner material**
    - **Validates: Requirements 9.1**

  - [x] 13.4 Write property test for the GTM decision contract
    - **Property 26: The GTM decision satisfies its conditional contract**
    - **Validates: Requirements 9.2, 9.3, 9.4, 9.5**

  - [x] 13.5 Write property test for name invariance
    - **Property 27: The GTM decision is invariant to names**
    - **Validates: Requirements 9.6**

- [x] 14. Stage 6 Handoff Generator
  - [x] 14.1 Implement the handoff generator module
    - `src/agent/stages/stage-6-handoff-generator.ts`: compose the five sections from stage 1–5 outputs only, reproducing the Stage 1 priority score, known-field count, and unknown slot labels exactly
    - Select the top three findings deterministically (verified claims ranked by dimension priority then numeric-figure presence); fewer than three → `"unknown"` entries plus `verifiedFindingsAvailable`
    - Template the suggested next step on the Stage 5 motion; reject any URL not present in the upstream URL set
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [x] 14.2 Write property test for handoff derivation
    - **Property 28: The handoff summary is derived and adds nothing**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7**

- [ ] 15. Checkpoint - all six stages implemented
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Run persistence
  - [x] 16.1 Implement the run store interface and JSON file backend
    - `src/store/run-store.ts` with `put`, `get`, `list`, `isDurable`, and implicit backend selection; `src/store/json-file-run-store.ts` writing `.data/runs/{runId}.json` with `isDurable: false`
    - Serialize and deserialize through the Zod schemas; `get` on an unknown id returns `null`
    - _Requirements: 16.1, 16.3, 16.4_

  - [x] 16.2 Implement the Upstash Redis backend
    - `src/store/upstash-run-store.ts`: REST client, key `run:{runId}`, capped `runs:index` sorted set, `isDurable: true`
    - Store write failure is logged and does not lose the in-memory artifact
    - _Requirements: 16.1, 16.5_

  - [x] 16.3 Write property test for artifact round-trip
    - **Property 34: Run artifact serialization round-trips**
    - **Validates: Requirements 16.1, 16.2, 16.4**

  - [x] 16.4 Write unit test for the unknown run id path
    - Assert `get` returns `null` for an absent run id
    - _Requirements: 16.3_

- [x] 17. API routes and SSE streaming
  - [x] 17.1 Implement the run trigger route
    - `src/app/api/run/route.ts`: Node runtime, `POST { rawEmail? }` validated by schema, `text/event-stream` response with `no-cache, no-transform`, `keep-alive`, and `X-Accel-Buffering: no`
    - Feed a `ReadableStream` from the orchestrator's `onEvent` sink with named events and increasing `id`; 15-second heartbeat comment frames; run continues server-side if the client disconnects
    - _Requirements: 2.2, 12.2, 15.6_

  - [x] 17.2 Implement the stored artifact route
    - `src/app/api/runs/[runId]/route.ts`: return the stored `RunArtifact`, 404 when absent
    - _Requirements: 16.2, 16.3_

  - [ ] 17.3 Write unit tests for both routes
    - Assert the trigger route accepts an absent body (fixed lead) and an alternative raw email, and returns SSE headers
    - Assert the artifact route returns 404 for an unknown run id
    - _Requirements: 1.6, 2.2, 16.2, 16.3_

- [x] 18. Run Console UI
  - [x] 18.1 Implement the run stream hook
    - `src/hooks/useRunStream.ts`: reducer over the event sequence tracking six stage statuses and the run status, deduping by `seq`, tolerating out-of-order arrival, never leaving a terminal stage status
    - Track `lastSeq`, detect stream interruption, expose reload and retry actions
    - _Requirements: 12.3, 12.4, 12.5, 12.6_

  - [x] 18.2 Write property test for the stream reducer
    - **Property 31: The stream reducer is order- and duplicate-tolerant**
    - **Validates: Requirements 12.3, 12.4, 12.6**

  - [x] 18.3 Implement the shared console components
    - `StagePanel.tsx` (independently expandable, labelled with stage number and name, status badge), `StageEventLog.tsx` (events rendered alongside that stage's output), `SourceLink.tsx` (real anchor with `href` equal to the source URL, status and timestamp on hover), `RunStatusBar.tsx`
    - _Requirements: 5.5, 11.4, 11.5, 12.6_

  - [x] 18.4 Implement the six stage views
    - `src/components/stage-views/Stage1View..Stage6View.tsx` rendering each typed output, with the framework justification, the per-dimension rubric breakdown table for winner and runner-up, and the progression rationale of drafts 2 and 3 as plain visible text
    - _Requirements: 11.4, 11.7_

  - [x] 18.5 Implement the run console page
    - `src/app/page.tsx` with `RunTrigger.tsx` (single control) and `LeadEditor.tsx` (paste an alternative raw email), wired to `useRunStream`, loading with no reviewer configuration
    - _Requirements: 12.1, 12.7, 15.5_

  - [x] 18.6 Implement the limitations, interruption, and durability notices
    - `LimitationsPanel.tsx` enumerating every dimension and field that resolved to `"unknown"`, `StreamInterruptedNotice.tsx` with elapsed time, last stage seen, and reload/retry controls, and a non-durable run store badge
    - _Requirements: 5.7, 12.5_

  - [x] 18.7 Implement the stored run page
    - `src/app/runs/[runId]/page.tsx` rendering a stored artifact with all six outputs, all events, and all source URLs, or a run-not-found notice
    - _Requirements: 16.2, 16.3_

  - [x] 18.8 Write property test for source link rendering
    - **Property 15: Source URLs render as resolvable links**
    - **Validates: Requirements 5.5**

  - [x] 18.9 Write property test for visible reasoning text
    - **Property 30: Reasoning artifacts render as visible text**
    - **Validates: Requirements 11.7**

  - [x] 18.10 Write component tests for the console
    - Six labelled expandable panels, event log adjacency, trigger control presence, lead editor submission, stream-interrupted notice with reload control
    - _Requirements: 11.4, 11.5, 12.1, 12.5, 12.7_

- [ ] 19. Repository hygiene, documentation, and hosting configuration
  - [x] 19.1 Write the README
    - What the system does, the six-stage architecture, the stage→source-file table with one row per stage, the local run command, every required environment variable, and the deployment target
    - Known limitations section covering every live third-party retrieval dependency, cold starts, cached-corpus staleness, and the dev-only JSON store
    - Document the OpenRouter free-tier quota reality: **50 requests/day** (1,000/day after the one-time $10 credit purchase) at **20 requests/minute**, against **~15–25 LLM calls per run** — roughly **two runs per day** on the bare free tier, which is why `LLM_MAX_RPM` and the completed-run permalink exist
    - Document the model choice rationale: `google/gemma-4-31b-it:free` for `response_format` JSON mode, best free-tier instruction following, a 262K context that fits full retrieved page text, versus the ~34% structured-output error rate of `openai/gpt-oss-20b:free`; state plainly that Gemma's structured-output rate is unreported (the 0.49% figure is tool-call), which is why `OPENROUTER_FALLBACK_MODEL` exists
    - _Requirements: 13.6, 14.3, 15.2, 15.3_

  - [ ] 19.2 Add the web-egress lint rule
    - ESLint rule banning `fetch`, `axios`, `undici`, and `node:http` imports outside `src/research/` and `src/providers/`
    - _Requirements: 13.4_

  - [x] 19.3 Add the hosting configuration
    - Render web service config and package scripts serving the Run Console and the run API from one Node process and public URL
    - _Requirements: 15.4, 15.6_

  - [ ] 19.4 Write repository hygiene static tests
    - `tests/unit/repo-hygiene.test.ts`: fixed-lead identifying strings absent from the rubric and GTM modules; no web-egress imports outside the allowed directories; the six stage files exist at their expected paths and each self-declared `sourceFile` equals its own path; the README stage table paths resolve; `.gitignore` covers `.env*`; `.env.example` key set equals the env schema key set
    - _Requirements: 1.1, 8.8, 13.1, 13.2, 13.3, 13.4, 13.6, 14.2, 14.3_

- [ ] 20. Full-pipeline wiring and end-to-end verification
  - [x] 20.1 Wire the artifact assembly and persistence into the pipeline
    - Populate `RunArtifact` with lead profile, all six `StageRecord`s, events, fetch ledger, `unknownFieldReport`, and `providerConfig` (names only), then persist on `complete` or `partial` and stream `run_completed` with the artifact URL
    - _Requirements: 2.4, 5.4, 11.6, 14.5, 16.1_

  - [ ] 20.2 Write property test for total retrieval failure
    - **Property 37: Total retrieval failure produces only unknowns, never placeholders**
    - **Validates: Requirements 17.6**

  - [ ] 20.3 Write opt-in live integration tests
    - Behind an env flag: crawl the real FlytBase case-studies index and assert a non-empty corpus with all seven fields present per record; Upstash round-trip through two separate client instances
    - _Requirements: 7.1, 16.5_

- [ ] 21. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; the anti-fabrication property tests (11, 12, 13, 37) are the ones worth keeping if only a few are run, since fabrication is an automatic disqualifier under the brief.
- Property tests run at 100 iterations minimum, 500 for the round-trip properties (20 and 34), each tagged with a comment naming the feature and property.
- Requirements verified by manual observation rather than tests (12.2 render latency, 15.4/15.5 single-URL deployment, 15.6 wall time) are recorded as measurements in the README under task 19.1, not as coding tasks.
- Property tests never touch the network or an LLM; the toolbelt is used real in provenance tests with only its transport stubbed. Task 1.5 makes this enforced by code (fetch guard plus shared stub provider helper), not left to convention.

### Live-run policy

- The OpenRouter free tier allows **50 LLM requests/day** and one full pipeline run costs **15–25** of them, so roughly **two runs per day** are available. Live model calls are a scarce resource and are spent deliberately.
- Full end-to-end runs against the live model are performed **ONLY when the user explicitly requests one** to verify progress. They are NEVER run automatically as part of completing a task, and NEVER as a default verification step after an implementation task.
- Per-task verification is limited to: type checking, linting, the build, and the mocked test suite. All of these are free and all of them MUST be run.
- The opt-in live integration tests (task 20.3) stay skipped by default and are run only on explicit request.
- If an implementation task appears to require a live call to verify, STOP and ask the user rather than spending quota.

### Time-budget triage

The implementing agent MUST follow this rule:

- If optional (`*`) test tasks are still being worked **past the halfway point of the available time budget**, STOP writing further optional tests and skip directly to tasks **19, 20, and 21** (README, hosting configuration, full-pipeline wiring, and the final checkpoint) so that a deployed, working public URL is guaranteed.
- When only a few property tests can be run, KEEP the anti-fabrication properties — **Property 11 (task 5.3), Property 12 (task 2.5), Property 13 (task 5.4), and Property 37 (task 20.2)** — and drop all other optional (`*`) tests first.
- Required (non-`*`) implementation tasks are **never** skipped by this rule; it governs optional test tasks only. Task 1.5 (test-time isolation) is required and is not subject to triage.
- Skipping ahead to tasks 19–21 does **not** authorize a live pipeline run: deployment and wiring are verified by type check, lint, build, and the mocked suite per the Live-run policy above, and a live run happens only on explicit user request.
- Rationale: fabrication is an automatic disqualifier under the brief, and an undeployed project cannot be evaluated at all. A deployed link plus the anti-fabrication guarantees dominates a fuller test suite with no URL.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.5", "2.7"] },
    { "id": 3, "tasks": ["1.6", "1.7", "1.8", "2.1", "2.2", "2.3", "3.1", "7.1", "9.1", "11.1", "12.1"] },
    { "id": 4, "tasks": ["2.4", "2.8", "2.9", "2.10", "3.2", "11.2", "11.3", "12.2", "12.4", "12.5", "12.7", "13.1", "16.1"] },
    { "id": 5, "tasks": ["2.5", "2.6", "3.3", "3.4", "4.1", "7.2", "11.4", "12.6", "16.2"] },
    { "id": 6, "tasks": ["4.2", "7.3", "7.4", "7.5", "7.6", "7.7", "8.1", "11.5", "11.6", "13.2", "16.3", "16.4"] },
    { "id": 7, "tasks": ["4.3", "8.2", "9.2", "11.7", "13.3", "13.4", "13.5"] },
    { "id": 8, "tasks": ["4.4", "5.1", "8.3", "8.4", "8.5", "8.6", "9.3", "9.4", "9.5", "11.8", "12.3", "14.1"] },
    { "id": 9, "tasks": ["4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "5.2", "14.2", "17.1", "17.2"] },
    { "id": 10, "tasks": ["5.3", "5.4", "5.5", "17.3", "18.1", "18.3", "19.1", "19.2", "19.3", "20.1"] },
    { "id": 11, "tasks": ["18.2", "18.4", "18.5", "18.6", "19.4", "20.2", "20.3"] },
    { "id": 12, "tasks": ["18.7", "18.8", "18.9", "18.10"] }
  ]
}
```
