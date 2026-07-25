/**
 * Client-side LLM call throttle (`src/providers/llm/throttle.ts`, Req 17.4, 17.6).
 *
 * All LLM adapters route their outbound calls through a single instance of this
 * throttle so the per-minute ceiling is enforced at one chokepoint rather than
 * re-implemented per provider. It is deliberately separate from the Research
 * Toolbelt's web-fetch politeness delay: that delay governs HTTP egress to
 * third-party pages and search APIs, whereas this throttle governs *model calls*.
 *
 * The queue is a FIFO over a sliding 60-second window of call **start**
 * timestamps. A call is released only when fewer than `maxRpm` starts fall
 * inside the trailing window; otherwise it waits until the oldest start ages
 * out. Submission order is preserved, so Stage 4's per-page extraction loop
 * degrades into a slower loop instead of a burst of 429s.
 *
 * `now` and `sleep` are injected so the queue is testable against a simulated
 * clock (Property 38). Rate-limit exhaustion is not modeled here — that degrades
 * like any other LLM failure in the adapter/orchestrator layer (Req 17.6).
 */

import type { LlmThrottle, ThrottleEvent } from "../../agent/contracts";

/** Width of the rolling window, in milliseconds. */
const WINDOW_MS = 60_000;

interface QueueEntry {
  purpose: string;
  submittedAt: number;
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export function createLlmThrottle(opts: {
  maxRpm: number; // LLM_MAX_RPM, default 20
  now: () => number; // injected clock (testability)
  sleep: (ms: number) => Promise<void>;
  emit: (event: ThrottleEvent) => void;
}): LlmThrottle {
  const { now, sleep, emit } = opts;
  // A ceiling below 1 is meaningless; clamp so the queue always makes progress.
  const maxRpm = Math.max(1, Math.floor(opts.maxRpm));

  // Start timestamps that still fall inside the trailing window, oldest first.
  const starts: number[] = [];
  const queue: QueueEntry[] = [];
  let pumping = false;

  /** Drop start timestamps that have aged out of the trailing window. */
  function prune(current: number): void {
    const cutoff = current - WINDOW_MS;
    while (starts.length > 0 && (starts[0] as number) <= cutoff) {
      starts.shift();
    }
  }

  /**
   * Processes the queue head-to-tail, releasing one call at a time. Only the
   * *release* (start) is gated; the released `fn` runs without blocking the
   * next release, so calls with arbitrary durations may overlap while their
   * starts stay under the ceiling.
   */
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (let entry = queue[0]; entry !== undefined; entry = queue[0]) {
        // Wait until a start slot is free inside the trailing window.
        for (;;) {
          const current = now();
          prune(current);
          if (starts.length < maxRpm) break;
          // Window is full: wait until the oldest start ages out.
          const oldest = starts[0] as number;
          const waitFor = oldest + WINDOW_MS - current;
          await sleep(waitFor);
        }

        const releaseAt = now();
        starts.push(releaseAt);
        queue.shift();

        const waitMs = releaseAt - entry.submittedAt;
        if (waitMs > 0) {
          const event: ThrottleEvent = {
            purpose: entry.purpose,
            waitMs,
            windowStartsInFlight: starts.length,
            maxRpm,
          };
          emit(event);
        }

        // Fire the call without awaiting so the next release is not blocked by
        // this call's duration. Errors flow back through the entry's promise.
        const released = entry;
        void Promise.resolve()
          .then(() => released.fn())
          .then(released.resolve, released.reject);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    schedule<T>(purpose: string, fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          purpose,
          submittedAt: now(),
          fn: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        // Kick the pump; it is a no-op if already running.
        void pump();
      });
    },
  };
}
