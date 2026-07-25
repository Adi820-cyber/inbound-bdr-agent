/**
 * Unit tests — `deliverHandoff` (AE handoff side channel).
 *
 * The property that matters most: delivery is OPTIONAL. With
 * `AE_HANDOFF_WEBHOOK_URL` unset, `deliverHandoff` must report
 * `delivered: false` without throwing and WITHOUT touching the network. The
 * transport module is mocked so an accidental egress shows up as a call on the
 * spy; the global no-live-calls guard would throw on a real one either way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunArtifact } from "@/agent/contracts";
import { UNKNOWN } from "@/agent/contracts";

const postJson = vi.fn();

vi.mock("@/providers/notify/webhook", () => ({
  postJson: (url: string, payload: unknown) => postJson(url, payload),
}));

const { buildHandoffPayload, deliverHandoff } = await import("@/agent/handoff-delivery");

const ENV_VAR = "AE_HANDOFF_WEBHOOK_URL";

/** A minimal but well-formed artifact: stages 1/5/6 populated, rest degraded. */
function makeArtifact(): RunArtifact {
  const degraded = (stage: number, stageName: string) => ({
    stage,
    stageName,
    sourceFile: `src/agent/stages/stage-${stage}.ts`,
    status: "failed" as const,
    attempts: 3,
    startedAt: "2026-02-01T00:00:00.000Z",
    completedAt: "2026-02-01T00:00:01.000Z",
    durationMs: 1000,
    output: UNKNOWN,
    failureReason: "stub",
  });

  const complete = <T,>(stage: number, stageName: string, output: T) => ({
    ...degraded(stage, stageName),
    status: "complete" as const,
    attempts: 1,
    output,
    failureReason: UNKNOWN,
  });

  return {
    schemaVersion: 1,
    runId: "run_TEST123",
    status: "partial",
    startedAt: "2026-02-01T00:00:00.000Z",
    completedAt: "2026-02-01T00:00:10.000Z",
    leadProfile: {
      leadId: "lead_1",
      senderName: "Ana Ruiz",
      senderEmail: "ana@acme-mining.cl",
      title: UNKNOWN,
      division: UNKNOWN,
      company: "Acme Mining",
      companyDomain: "acme-mining.cl",
      country: UNKNOWN,
      region: UNKNOWN,
      industry: UNKNOWN,
      statedUseCase: UNKNOWN,
      statedPainPoints: [],
      referralSource: UNKNOWN,
      statedTimeline: UNKNOWN,
      siteCount: 4,
      rawEmail: {
        fromName: "Ana Ruiz",
        fromEmail: "ana@acme-mining.cl",
        subject: "Inspections",
        body: "Four sites.",
      },
      normalizedAt: "2026-02-01T00:00:00.000Z",
    },
    providerConfig: {
      llmProvider: "openrouter",
      llmModel: "test/model",
      llmFallbackModel: UNKNOWN,
      llmMaxRpm: 20,
      searchProvider: "tavily",
      runStoreBackend: "json_file",
      runStoreDurable: false,
    },
    stages: {
      stage1: complete(1, "Qualifier", {
        framework: "MEDDPICC",
        frameworkSlots: [],
        frameworkSelectionJustification: "stub",
        justificationLeadAttributes: ["company", "siteCount"],
        knownFields: [],
        unknownFields: [],
        priorityScore: 78,
        scoreFactors: [],
        scoreReasoning: "stub",
        fitAssessment: "strong_fit",
      }),
      stage2: degraded(2, "Researcher"),
      stage3: degraded(3, "Responder"),
      stage4: degraded(4, "Matcher"),
      stage5: complete(5, "GTM Advisor", {
        motion: "partner_led",
        reasoning: "stub",
        geographyConsidered: UNKNOWN,
        complexity: {
          complexityScore: 3,
          signals: {
            siteCount: 4,
            continuousOperations: true,
            regulatedEnvironment: true,
            multiStakeholder: true,
            dealSizeIndicator: "mid",
          },
          explanation: "stub",
        },
        regionalPartnerEvidence: UNKNOWN,
        derivedWithoutPartnerEvidence: true,
        partnerType: "systems_integrator",
        decisionInputsSnapshot: {},
      }),
      stage6: complete(6, "Handoff", {
        buyerContext: "Four-site copper operation.",
        qualificationStatus: {
          framework: "MEDDPICC",
          priorityScore: 78,
          fitAssessment: "strong_fit",
          knownFieldCount: 5,
          unknownSlotLabels: ["Economic Buyer"],
        },
        topThreeFindings: [
          { claimId: "claim_a_1", finding: "Expanding autonomy program", sourceUrl: "https://a.example/1" },
          { claimId: "claim_b_1", finding: "New CTO hired", sourceUrl: "https://b.example/2" },
          { claimId: UNKNOWN, finding: UNKNOWN, sourceUrl: UNKNOWN },
        ],
        verifiedFindingsAvailable: 2,
        recommendedCaseStudy: {
          sourceUrl: "https://flytbase.com/case-studies/mining",
          title: "Mining inspections",
          whyItWon: "Industry and geography match",
        },
        suggestedNextStep: {
          action: "Introduce the regional partner",
          rationale: "stub",
          consistentWithMotion: "partner_led",
        },
      }),
    },
    events: [],
    fetchLedger: [],
    unknownFieldReport: [],
  } as unknown as RunArtifact;
}

describe("deliverHandoff — not configured", () => {
  const saved = process.env[ENV_VAR];

  beforeEach(() => {
    postJson.mockReset();
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved;
  });

  it("returns delivered:false with channel 'none' and a clear reason", async () => {
    const result = await deliverHandoff(makeArtifact());

    expect(result).toEqual({
      delivered: false,
      channel: "none",
      reason: "AE_HANDOFF_WEBHOOK_URL not configured",
    });
  });

  it("makes no network call at all", async () => {
    await deliverHandoff(makeArtifact());

    expect(postJson).not.toHaveBeenCalled();
  });

  it("does not throw", async () => {
    await expect(deliverHandoff(makeArtifact())).resolves.toBeDefined();
  });
});

describe("deliverHandoff — configured", () => {
  beforeEach(() => {
    postJson.mockReset();
  });

  it("POSTs a Slack-compatible payload and reports success", async () => {
    postJson.mockResolvedValue({ ok: true, status: 200 });

    const result = await deliverHandoff(makeArtifact(), {
      webhookUrl: "https://hooks.example.com/abc",
      baseUrl: "https://bdr.example.com",
    });

    expect(result).toEqual({ delivered: true, channel: "webhook" });
    expect(postJson).toHaveBeenCalledTimes(1);

    const [url, payload] = postJson.mock.calls[0]! as [string, Record<string, unknown>];
    expect(url).toBe("https://hooks.example.com/abc");
    expect(payload.runId).toBe("run_TEST123");
    expect(payload.permalink).toBe("https://bdr.example.com/runs/run_TEST123");
    expect(payload.company).toBe("Acme Mining");
    expect(payload.priorityScore).toBe(78);
    expect(payload.fitAssessment).toBe("strong_fit");
    expect(payload.gtmMotion).toBe("partner_led");
    expect(payload.recommendedCaseStudyUrl).toBe(
      "https://flytbase.com/case-studies/mining",
    );
    expect(payload.topFindings).toHaveLength(3);
    // Slack renders this field.
    expect(String(payload.text)).toContain("Acme Mining");
    expect(String(payload.text)).toContain("https://bdr.example.com/runs/run_TEST123");
  });

  it("reports a transport failure without throwing", async () => {
    postJson.mockResolvedValue({ ok: false, status: 500, reason: "webhook responded with status 500" });

    const result = await deliverHandoff(makeArtifact(), {
      webhookUrl: "https://hooks.example.com/abc",
    });

    expect(result).toEqual({
      delivered: false,
      channel: "webhook",
      reason: "webhook responded with status 500",
    });
  });

  it("swallows a thrown transport error", async () => {
    postJson.mockRejectedValue(new Error("boom"));

    const result = await deliverHandoff(makeArtifact(), {
      webhookUrl: "https://hooks.example.com/abc",
    });

    expect(result).toEqual({ delivered: false, channel: "webhook", reason: "boom" });
  });
});

describe("buildHandoffPayload", () => {
  it("uses a relative permalink when no base url is given", () => {
    expect(buildHandoffPayload(makeArtifact()).permalink).toBe("/runs/run_TEST123");
  });

  it("reports unknown fields as the unknown marker, never invented", () => {
    const artifact = makeArtifact();
    artifact.stages.stage6.output = UNKNOWN;
    artifact.stages.stage1.output = UNKNOWN;
    artifact.stages.stage5.output = UNKNOWN;

    const payload = buildHandoffPayload(artifact);

    expect(payload.priorityScore).toBe(UNKNOWN);
    expect(payload.fitAssessment).toBe(UNKNOWN);
    expect(payload.gtmMotion).toBe(UNKNOWN);
    expect(payload.recommendedCaseStudyUrl).toBe(UNKNOWN);
    expect(payload.topFindings).toEqual([]);
  });
});
