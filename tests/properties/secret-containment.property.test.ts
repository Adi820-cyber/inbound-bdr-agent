/**
 * Property 33 — Secrets never leave the server.
 *
 * **Validates: Requirements 14.5, 14.6**
 *
 * Every event is run through `redactStageEvent` at the `emit` chokepoint before
 * it reaches the SSE sink or the artifact, and the whole artifact is redacted
 * once more before it is returned. A secret-looking `sk-…` credential is caught
 * by the redaction pattern pass even when it is not one of this process's
 * configured keys, so a stage that leaks such a sentinel into an event message
 * or its output can never surface it.
 *
 * For an arbitrary `sk-…` sentinel (and arbitrary benign surrounding text), a
 * stage emits the sentinel in a `reasoning` event message AND returns it inside
 * its output. This suite asserts:
 *
 *   - no emitted event, serialized, contains the sentinel;
 *   - the returned artifact, serialized, does not contain the sentinel;
 *   - the sentinel is replaced by `[REDACTED]` wherever it appeared;
 *   - benign text is preserved.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StageEvent } from "@/agent/contracts";
import { runPipeline } from "@/agent/orchestrator";
import { REDACTION_PLACEHOLDER } from "@/agent/redact";
import { z } from "zod";

import { fakeStage, makeDeps } from "@tests/support/orchestrator-harness";

/** `sk-` + ≥8 key chars ⇒ matches the orchestrator's SK_KEY redaction pattern. */
const arbSentinel = fc
  .stringMatching(/^[A-Za-z0-9]{8,40}$/)
  .map((body) => `sk-${body}`);

/** Benign text that must survive redaction (no `sk-`/`Bearer` substrings). */
const arbBenign = fc.stringMatching(/^[A-Za-z0-9 ]{0,20}$/);

const outputSchema = z.object({ marker: z.string(), leaked: z.string() });

describe("Property 33: secrets never leave the server (Req 14.5, 14.6)", () => {
  it("scrubs an sk- sentinel from every event and the returned artifact", async () => {
    await fc.assert(
      fc.asyncProperty(arbSentinel, arbBenign, async (sentinel, benign) => {
        const received: StageEvent[] = [];

        const leaker = fakeStage({
          stage: 1,
          schema: outputSchema,
          run: (ctx) => {
            // Leak the sentinel into an event message...
            ctx.emit({
              stage: 1,
              stageName: "Stage 1",
              type: "reasoning",
              message: `${benign} key=${sentinel} ${benign}`,
            });
            // ...and into the stage output.
            return { marker: "stage-1", leaked: `${benign}:${sentinel}` };
          },
        });

        const artifact = await runPipeline({
          onEvent: (e) => received.push(e),
          deps: makeDeps({ stages: [leaker] }),
        });

        // No event, serialized, still carries the sentinel.
        for (const event of received) {
          expect(JSON.stringify(event)).not.toContain(sentinel);
        }

        // The returned artifact does not carry the sentinel anywhere.
        const artifactJson = JSON.stringify(artifact);
        expect(artifactJson).not.toContain(sentinel);

        // The sentinel was replaced by the redaction placeholder.
        expect(artifactJson).toContain(REDACTION_PLACEHOLDER);

        // Benign text survived (when it is non-empty and distinct from the marker).
        if (benign.trim().length > 0) {
          expect(artifactJson).toContain(benign);
        }
      }),
      { numRuns: 100 },
    );
  });
});
