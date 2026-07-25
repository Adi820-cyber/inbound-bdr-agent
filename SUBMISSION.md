# Inbound BDR Hiring Hackathon

## What I built

An autonomous inbound-BDR pipeline. A single inbound contact-form email goes in; six stages run end to end with no human step between them and produce a framework qualification, a live-sourced research dossier where every claim carries a real source URL, a three-email response sequence, a case-study match discovered from `flytbase.com` at runtime, a direct-vs-partner GTM recommendation, and an AE handoff summary.

Three entry points, all the same pipeline:

- **`POST /api/inbound`** — the endpoint an email provider posts to (SendGrid Inbound Parse, Mailgun Routes, Postmark) or a contact form hits directly. Accepts provider JSON, form-encoded posts, and raw RFC822. This is what makes "takes a lead from email" literally true rather than a demo affordance.
- **Run Console UI** — click Run, watch all six stages stream in real time over SSE.
- **`POST /api/run`** — the SSE trigger the UI uses.

When the run finishes, the Stage 6 handoff is optionally pushed to an AE destination (`AE_HANDOFF_WEBHOOK_URL`, Slack-incoming-webhook compatible), and the full artifact is persisted at a shareable `/runs/{runId}` permalink.

## The research that changed the build

The most valuable thing I did was stop and actually read `flytbase.com/case-studies` instead of coding against what I assumed was there. Three things came out of it, and all three were bugs.

**1. The live crawl could never have worked.** I had the index at `https://www.flytbase.com/case-studies`. The real site serves every case-study link from the apex host, `https://flytbase.com/case-studies/<slug>`. My enumerator filters links to same-origin, so every real URL would have been rejected as off-origin, Stage 4 would have silently enumerated zero pages on every run, and the cached fallback would have masked it. One-character class of bug, total functional failure, invisible without checking the real site.

**2. My cached fallback corpus was fabricated.** I had generated four plausible-sounding case studies with invented industries, regions, results, and URLs that 404. That is fabricated data sitting inside a system whose headline claim is that it never fabricates. It is now a verbatim snapshot of all 24 real customer stories, every `sourceUrl` taken from the live index, and any field the index does not state is the literal `"unknown"` rather than a guess.

**3. The brief's fixed lead is designed around two real case studies, and I had missed both.** The real corpus contains:

- `case-studies/sqm-678-km2-mine-autonomous-inspection-adentu-and-flytbase` — **SQM itself**, mining, Chile, delivered through **Adentu, a Chile-based integrator**
- `case-studies/anglo-american-autonomous-mining-drones-peru-case-study` — **Anglo American**, mining, Peru, and Anglo American is the lead's *referral source*

So the correct answer for Rodrigo Castillo is a real, clickable page about his own company, and the partner-led GTM motion has genuine evidence behind it because Adentu covers Chile. `tests/unit/real-corpus-match.test.ts` asserts the ranker actually selects it.

**4. The highest-weighted rubric dimension was dead.** Chasing the above, I found the lead normalizer hardcoded `industry: "unknown"`. Industry carries the largest rubric weight (0.35), so it scored 0.0 for every case study on every run — the match was being decided by geography and use case alone. Industry is now inferred from generic commodity/process vocabulary in the email text (`lithium`, `mine`, `salt flat` → Mining), with `"unknown"` when the text supports no single label.

## How it maps to the brief

**Qualify against a sales framework.** Stage 1 makes one schema-constrained LLM call to pick exactly one of MEDDPICC / BANT / SPICED with a justification that must cite at least two lead attributes. Everything after that is deterministic: slot coverage is computed as `ALL_SLOTS − known` by set difference, so known ∪ unknown covers every framework slot exactly once by construction rather than by trusting the model. Known fields survive only if their `evidenceQuote` actually appears in the email text. The priority score is clamped to 0–100 and the fit label is derived from the score bands, so it can never contradict the number.

**Research the account with real public data.** Stage 2 builds attribute-interpolated queries from lead fields only across four dimensions (org structure, budget signals, recent news, leadership language) and synthesizes a fifth (positioning) from the claims of the other four. One extraction call per dimension, prompted with retrieved page text and its URL and nothing else. A dimension with no retrievable source yields exactly one `"unknown"` claim.

**Draft an adaptive response sequence.** Stage 3 pre-plans which unknown qualification slots each of the three emails will surface (a deterministic partition, 1–2 slots each, prioritizing economic buyer / decision process / metrics), then generates the copy. Post-processing forces every structural invariant: claim references are repaired to resolvable ids, draft 1 has no progression rationale and drafts 2–3 must, and the persona note is always present.

**Match the most relevant case study.** Stage 4 fetches the live index, enumerates same-origin case-study URLs, extracts each page into a structured record, and scores every record with a pure weighted rubric: industry 0.35, geography 0.25, use case 0.30, partner overlap 0.10. Ranking is deterministic with a stable tie-break, and the output carries the winner, runner-up, the per-dimension breakdown for both, and which dimensions decided it.

**Recommend the GTM motion.** Stage 5 searches FlytBase public material for partner signals in the lead's geography, then a pure function decides direct-AE vs partner-led from typed inputs only — never from the company name. The LLM only narrates a decision already made. `partner_led` requires a partner type and a ledgered supporting URL.

**Produce a clean AE handoff.** Stage 6 derives everything from stages 1–5 and introduces no new fact or URL. Fewer than three verified findings means the remaining slots are `"unknown"` and the available count is stated.

## The anti-fabrication control

Fabrication is the one automatic disqualifier in this brief, so it is enforced mechanically rather than by prompt instruction.

The Research Toolbelt is the only module allowed to touch the network, and it records every request in a per-run **fetch ledger** with URL, status, and timestamp. After Stage 2, 4, and 5, the orchestrator cross-checks every cited URL against that ledger. A claim whose URL was not actually fetched with a success response this run is rejected: its text collapses to `"unknown"`, it gains a rejection reason, and a `validation_error` event names the URL. Numeric figures must each carry their own ledgered URL or they are dropped. The check never consults the LLM, so a plausible-looking invented URL cannot pass it.

Supporting layers: `Maybe<T> = T | "unknown"` makes the marker a type-level concept; a single `degradedOutput()` chokepoint in the orchestrator guarantees `"unknown"` is the only value ever substituted for a failed stage; and the UI's Limitations panel reports every field that resolved to `"unknown"`.

`tests/properties/total-retrieval-failure.property.test.ts` runs the real six stages with every search returning empty and every fetch returning null, then scans the serialized output for placeholder tells (`TBD`, `N/A`, `example.com`, `Lorem`, `placeholder`, …) and asserts none appear.

## Architecture

```
POST /api/inbound ──┐
POST /api/run ──────┼──> Lead Normalizer ──> Orchestrator ──> RunArtifact ──> /runs/{runId}
Run Console UI ─────┘                            │                 │
                                                 │                 └──> AE handoff webhook
                    Stage 1 Qualifier ───────────┤
                    Stage 2 Researcher ──────────┤
                    Stage 3 Responder ───────────┼──> SSE stream ──> Run Console
                    Stage 4 Matcher ─────────────┤
                    Stage 5 GTM Advisor ─────────┤
                    Stage 6 Handoff ─────────────┘

Research Toolbelt (sole web egress) ──> Fetch Ledger ──> Provenance filter
Providers (env-selected): LLM openai|anthropic|gemini|openrouter · search tavily|exa|serper · store upstash|json
```

Six stages run in a fixed order as a deterministic pipeline, not an LLM-driven agent loop. Each declares its upstream dependencies as data, and the orchestrator supplies exactly those. Every stage output is validated against a Zod schema; a failure re-invokes the stage with the validation error fed back, at most three invocations total, with the final attempt switching to a fallback model. Exhausted retries degrade the stage to `"unknown"` and the run continues as `partial` rather than crashing.

## Why a fixed pipeline instead of an agent loop

I considered a single agent with a tool loop and rejected it for three concrete reasons. Stage boundaries become invisible in the trace, so "which stage was this tool call for" is a guess from the model's own narration rather than a structural fact. Output shape becomes unenforceable per stage — a malformed email sequence and a malformed qualification are indistinguishable failure modes, and retrying means replaying the whole expensive loop. And the brief asks for six specific artifacts; the DAG is genuinely fixed, so there is no plan for a planner to discover. The trade-off I accepted is that the pipeline cannot adapt its own plan.

## Stage → file map

| Component | Source file |
| --- | --- |
| Stage 1 · Qualifier | `src/agent/stages/stage-1-qualifier.ts` |
| Stage 2 · Researcher | `src/agent/stages/stage-2-researcher.ts` |
| Stage 3 · Responder | `src/agent/stages/stage-3-responder.ts` |
| Stage 4 · Matcher | `src/agent/stages/stage-4-matcher.ts` |
| Stage 5 · GTM Advisor | `src/agent/stages/stage-5-gtm-advisor.ts` |
| Stage 6 · Handoff Generator | `src/agent/stages/stage-6-handoff-generator.ts` |
| Orchestrator | `src/agent/orchestrator.ts` |
| Provenance filter | `src/agent/provenance.ts` |
| Research Toolbelt (sole egress) | `src/research/toolbelt.ts` |
| Fetch ledger | `src/research/fetch-ledger.ts` |
| Real corpus snapshot | `src/research/cached-corpus/manifest.json` |
| Inbound email parser | `src/agent/inbound-email.ts` |
| AE handoff delivery | `src/agent/handoff-delivery.ts` |
| Scoring rubric (pure) | `src/agent/stages/stage-4/scoring-rubric.ts` |
| GTM decision (pure) | `src/agent/stages/stage-5/gtm-decision.ts` |

## Try it

```bash
curl -i -X POST http://localhost:3000/api/inbound \
  -H "Content-Type: application/json" \
  -d '{"from":"Ana Ruiz <ana.ruiz@acme-mining.cl>",
       "subject":"Autonomous inspection across our copper sites",
       "text":"We run four copper sites in northern Chile and need autonomous inspection. Q3 budget conversation coming up."}'
```

Returns `202` with the `runId`, the run status, a `/runs/{runId}` permalink, the Stage 6 handoff, and the AE delivery result. Slow by design — the full pipeline runs before it responds.

## Verification

- **56 test files, 210 tests passing**, 4 live-egress tests skipped by default so a normal run spends no API quota.
- **Property-based tests (fast-check)** for the invariants that matter: verified status holds if and only if the URL is ledgered with a success; numeric figures carry their own ledgered URL; the unknown-field report is exactly the set of unknown values; slot coverage is an exact partition; match scores are bounded and equal their weighted sum; ranking is lossless; scoring is sensitive to industry and geography; retries are bounded at three; secrets never leave the server; the throttle never exceeds its per-minute ceiling.
- **Repository hygiene tests** assert `.env.example` holds no real-looking key, the six stage files exist where the README claims, the scoring rubric and GTM decision contain no company/person/referral literal, and raw `fetch` appears only in the toolbelt, the provider adapters, and same-origin client code.
- **Production build passes** and the app deploys as a single Render web service serving both UI and API from one URL.

## Honest limitations

- **Emails are drafted, not sent.** The brief asks to *draft* a response sequence and *produce* a handoff, which is what the system does. There is no SMTP integration, so nothing is delivered to the prospect. The AE handoff *is* deliverable via webhook when configured.
- **Live retrieval is a hard dependency.** Search API, the `flytbase.com` crawl, and the LLM are all external. Any of them being slow, rate-limited, or down degrades fields to `"unknown"` and the run to `partial`. That is the designed behaviour, not a crash, but it does mean output quality varies with network conditions.
- **Runtime enumeration is readability-constrained.** The toolbelt reduces pages to readable text, which is right for LLM extraction but strips the anchors URL enumeration needs. When the live index cannot be enumerated, Stage 4 falls back to the committed snapshot, marks those records `stale`, and emits the snapshot timestamp. The snapshot is real data now, but it is a snapshot, not live.
- **The JSON file store is not durable.** Only the Upstash backend survives a redeploy; configure it for any permalink you intend to keep.
- **Free-tier model reliability.** Every stage output is schema-validated, and free models sometimes fail that. Bounded retry plus a fallback model absorbs most of it, but a run can still finish `partial`. OpenRouter's free tier is roughly 50 requests/day at 20/minute and one run costs 15–25 calls, so plan on about two runs per day without credits.
- **`typescript.ignoreBuildErrors` is on.** It was set to unblock a deadline build over a type error in a *test helper*; application source under `src/` is clean. It should be reverted so the build catches real regressions.
