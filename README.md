# Inbound BDR Agent

The Inbound BDR Agent consumes a single inbound contact-form email and autonomously produces a full business-development workup for it: a qualification against an explicit sales framework, live-sourced account research, a three-email outbound sequence, a case-study match discovered from flytbase.com at runtime, a go-to-market motion recommendation, and an AE handoff summary.

The system is built around a hard **anti-fabrication guarantee**: every factual claim it emits carries a source URL that was actually fetched and recorded in a per-run fetch ledger, or the value resolves to the literal marker `"unknown"`. Nothing is invented. If a source cannot be retrieved, the corresponding field degrades to `"unknown"` and the run is reported as `partial` rather than silently filled with a plausible-looking placeholder.

## What it does

Given one raw email (the built-in fixed lead is Rodrigo Castillo of SQM, or an arbitrary email you supply), the agent runs six stages end-to-end in a single run and streams each stage's inputs, tool calls, reasoning, and outputs as it goes:

1. **Qualifier** — selects exactly one qualification framework (MEDDPICC, BANT, or SPICED), grounds every known field in the lead text, scores priority 0–100, and reports which framework slots are still unknown.
2. **Researcher** — issues live search/fetch requests across four dimensions (org structure, budget signals, recent news, leadership language), extracts claims with supporting quotes and source URLs, and synthesizes a positioning recommendation. Dimensions with no retrievable source yield a single `"unknown"` claim.
3. **Responder** — writes exactly three emails covering the unknown qualification slots, each referencing verified research claims, with send-timing guidance and progression rationale.
4. **Matcher** — enumerates FlytBase case-study URLs at runtime, extracts each into a structured record, and picks a winner and runner-up using a published, attribute-driven scoring rubric.
5. **GTM Advisor** — searches FlytBase public material for partner-ecosystem signals in the lead's geography and recommends a direct-AE or partner-led motion, grounded in ledgered evidence.
6. **Handoff Generator** — assembles a single scannable AE handoff summary: buyer context, qualification status, top research findings, the recommended case study, and a suggested next step.

## Architecture

Six deterministic stages run in fixed order 1→6 under an orchestrator. Each stage receives exactly its declared upstream dependencies, is validated against a Zod contract with bounded retry, and degrades to `"unknown"` on failure rather than aborting the run. All web egress flows through a single Research Toolbelt, and every request it makes is recorded in an append-only fetch ledger that the provenance filter cross-checks before any claim is allowed to be `verified`.

### Stage → source-file map

| Component | Source file |
| --- | --- |
| Stage 1 · Qualifier | `src/agent/stages/stage-1-qualifier.ts` |
| Stage 2 · Researcher | `src/agent/stages/stage-2-researcher.ts` |
| Stage 3 · Responder | `src/agent/stages/stage-3-responder.ts` |
| Stage 4 · Matcher | `src/agent/stages/stage-4-matcher.ts` |
| Stage 5 · GTM Advisor | `src/agent/stages/stage-5-gtm-advisor.ts` |
| Stage 6 · Handoff Generator | `src/agent/stages/stage-6-handoff-generator.ts` |
| Orchestrator | `src/agent/orchestrator.ts` |
| Research Toolbelt (sole web egress) | `src/research/toolbelt.ts` |
| Fetch ledger (provenance record) | `src/research/fetch-ledger.ts` |

## Running locally

Requires Node.js `>=20.9.0`.

```bash
npm install
cp .env.example .env    # then fill in the keys you need (see below)
npm run dev             # starts the Run Console at http://localhost:3000
```

Run the test suite (unit + property-based tests, non-watch):

```bash
npm test
# or directly:
npx vitest run
```

Other useful scripts: `npm run typecheck`, `npm run lint`, and `npm run verify` (typecheck + lint + test).

## Environment variables

The full template lives in [`.env.example`](./.env.example). Copy it to `.env` and fill in values. **Only the selected provider's key is required** — the selector variables (`LLM_PROVIDER`, `SEARCH_PROVIDER`) decide which single key you actually need, and the keys for the unselected providers can stay blank.

### Provider selection

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | Which LLM adapter to use: `openai` \| `anthropic` \| `gemini` \| `openrouter`. |
| `SEARCH_PROVIDER` | Which web search adapter to use: `tavily` \| `exa` \| `serper`. |

### Provider keys (only the selected one is required)

| Variable | Required when |
| --- | --- |
| `OPENAI_API_KEY` | `LLM_PROVIDER=openai` |
| `ANTHROPIC_API_KEY` | `LLM_PROVIDER=anthropic` |
| `GEMINI_API_KEY` | `LLM_PROVIDER=gemini` |
| `OPENROUTER_API_KEY` | `LLM_PROVIDER=openrouter` |
| `TAVILY_API_KEY` | `SEARCH_PROVIDER=tavily` |
| `EXA_API_KEY` | `SEARCH_PROVIDER=exa` |
| `SERPER_API_KEY` | `SEARCH_PROVIDER=serper` |

### OpenRouter and throttle (optional, defaulted)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_MODEL` | `google/gemma-4-31b-it:free` | Primary model slug used through OpenRouter. |
| `OPENROUTER_FALLBACK_MODEL` | `google/gemma-4-26b-a4b-it:free` | Secondary model, tried only on a stage's final attempt after the primary exhausts schema retries. |
| `OPENROUTER_APP_URL` | — | Sent as the `HTTP-Referer` attribution header. Carries no secret. |
| `OPENROUTER_APP_TITLE` | — | Sent as the `X-Title` attribution header. Carries no secret. |
| `LLM_MAX_RPM` | `20` | Client-side ceiling on LLM requests per rolling minute, across all adapters. |

### Run store (optional — both required together to enable Upstash)

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint for durable run persistence. |
| `UPSTASH_REDIS_REST_TOKEN` | REST token paired with the URL above. |

If both Upstash variables are present, runs persist durably. Otherwise the process falls back to a development-only JSON file store under `.data/runs/`.

### Retrieval tuning (optional, defaulted)

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRAWL_MAX_PAGES` | `12` | Maximum number of case-study pages crawled per run. |
| `REQUEST_TIMEOUT_MS` | `15000` | Per-request HTTP timeout in milliseconds for search and page fetches. |

## Deployment

The application deploys as a single **Render web service** that serves both the Run Console and the run API from one public URL. Runs stream their stage events over a long-lived Server-Sent Events (SSE) connection, which Render sustains for the full duration of a run.

Two things to note for reviewers:

- **Free-tier cold start.** On Render's free tier the service spins down when idle, so the first request after a period of inactivity incurs a cold-start delay of a few seconds while the process wakes up.
- **Shareable completed runs.** Every completed run is persisted and retrievable by a permalink of the form `/runs/{runId}`. Rather than waiting through a live run, a reviewer can open a permalink to a run that has already finished and inspect all six stage outputs, every stage event, and every source URL.

### OpenRouter free-tier quota reality

If you run through OpenRouter's free models, plan around the quota:

- **50 requests/day** on the bare free tier (**1,000/day** after the one-time $10 credit purchase), at **20 requests/minute**.
- A single run makes roughly **15–25 LLM calls**.
- That works out to about **two runs per day** on the bare free tier.

This is exactly why `LLM_MAX_RPM` (to stay under the per-minute ceiling) and the completed-run permalink (so reviewers can inspect a finished run without spending a fresh run) exist.

### Model choice rationale

The default primary model is `google/gemma-4-31b-it:free`, chosen for:

- native `response_format` JSON mode, which the stages depend on for structured output,
- the strongest free-tier instruction following we measured,
- a 262K context window large enough to hold full retrieved page text during extraction.

By contrast, `openai/gpt-oss-20b:free` showed roughly a **34% structured-output error rate** in our testing. To be candid: Gemma's structured-output error rate is *unreported* (the frequently-cited 0.49% figure is a tool-call metric, not structured output), which is precisely why `OPENROUTER_FALLBACK_MODEL` exists — a stage's final attempt switches to the fallback model when the primary keeps failing schema validation.

## Known limitations

- **Live third-party retrieval dependencies.** Every factual output depends on live external services, and any of them being slow, rate-limited, or down degrades results to `"unknown"` and the run to `partial`:
  - the configured **web search API** (Tavily / Exa / Serper),
  - live crawling of **flytbase.com** for the case-study corpus,
  - the **LLM provider** for qualification, extraction, generation, and narration.
- **Runtime case-study enumeration is readability-constrained.** Stage 4 enumerates and extracts case studies from the live flytbase.com site, so it is subject to the site's markup being parseable into readable text within the token budget. When the live index cannot be enumerated, the stage falls back to the **committed cached corpus** under `src/research/cached-corpus/`, marks the affected records `stale`, and emits the snapshot timestamp. With no snapshot available, the stage fails and the match result is `"unknown"`.
- **The JSON-file store is not durable.** The development JSON file store under `.data/runs/` does not survive a redeploy. Only the Upstash Redis backend persists runs across redeployments, so configure the Upstash variables for any run you intend to keep a permalink for.
- **Free-model structured-output caveat.** Free-tier models occasionally return output that fails schema validation; the bounded-retry-plus-fallback path handles this, but a run can still finish `partial` if a stage exhausts its attempts.

### Manual measurements

The following are recorded here by observation rather than automated test:

- **Render single-URL deployment** — the Run Console and run API are served from one public URL, and opening that URL loads the Run trigger without any reviewer configuration.
- **Run wall time** — a full six-stage run is dominated by live retrieval and LLM latency; expect on the order of a few minutes end-to-end, streamed over SSE rather than returned in a single request.
- **Stage render latency** — stage panels populate incrementally as each `stage_completed` event arrives, so the console stays observable throughout a long run.
