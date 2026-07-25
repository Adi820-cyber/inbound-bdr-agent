/**
 * Property 38 — The LLM throttle never exceeds the configured per-minute ceiling.
 *
 * **Validates: Requirements 17.4**
 *
 * `createLlmThrottle` takes `now`/`sleep` as parameters precisely so it can be
 * driven against a *simulated* clock rather than the wall clock (see the
 * design's "Mocking Boundaries": Property 38 runs against a simulated clock so
 * 100+ iterations cost milliseconds, not minutes). This file builds that clock.
 *
 * The harness is an event-driven virtual-time simulation:
 *
 *   - `SimClock` keeps a single virtual `now` and a min-ordered set of timers.
 *     `sleep(ms)` registers a timer that resolves after the clock advances by
 *     `ms`; `at(t, fn)` registers a one-shot callback at virtual time `t`
 *     (used to submit each scheduled call at its offset).
 *   - The driver repeatedly fires the earliest timer, advancing virtual time to
 *     it, then flushes the JS microtask queue (via `setImmediate`) so the
 *     throttle's `pump` loop can react before the next timer fires. Because the
 *     throttle's only asynchrony is the injected `sleep`, resolving timers plus
 *     flushing microtasks deterministically drives the whole queue to drain.
 *
 * Given that clock, we assert the three parts of Property 38:
 *   1. no trailing 60 000 ms window over the recorded call *starts* holds more
 *      than the effective `maxRpm` starts;
 *   2. every scheduled call runs exactly once, and the release order equals the
 *      submission order;
 *   3. every call that actually waited (released later than it was submitted)
 *      emitted a `throttled` event whose `waitMs` equals that wait.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ThrottleEvent } from "@/agent/contracts";
import { createLlmThrottle } from "@/providers/llm/throttle";

import { arbThrottleSchedule } from "./arbitraries";

/** Must match the throttle's internal rolling-window width. */
const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Simulated clock
// ---------------------------------------------------------------------------

interface Timer {
  at: number; // virtual time the timer fires
  order: number; // insertion order — deterministic tiebreak for equal `at`
  fire: () => void;
}

/**
 * A deterministic virtual clock. `now()` and `sleep()` are handed to the
 * throttle; `at()` lets the driver inject submissions at their offsets. Nothing
 * here touches real time.
 */
class SimClock {
  private t = 0;
  private seq = 0;
  private readonly timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  /** Resolves after virtual time advances by `ms`. `ms <= 0` resolves at once. */
  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + ms, order: this.seq++, fire: resolve });
    });
  }

  /** Schedules `fn` to run at virtual time `time` (never in the past). */
  at(time: number, fn: () => void): void {
    this.timers.push({ at: Math.max(time, this.t), order: this.seq++, fire: fn });
  }

  private takeEarliest(): Timer | undefined {
    if (this.timers.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.timers.length; i += 1) {
      const a = this.timers[i] as Timer;
      const b = this.timers[best] as Timer;
      if (a.at < b.at || (a.at === b.at && a.order < b.order)) best = i;
    }
    return this.timers.splice(best, 1)[0];
  }

  /**
   * Fires the single earliest timer, advancing virtual time to it. Returns
   * false when no timers remain (the simulation is drained).
   */
  fireEarliest(): boolean {
    const next = this.takeEarliest();
    if (next === undefined) return false;
    // Virtual time only moves forward; ties keep it fixed.
    this.t = Math.max(this.t, next.at);
    next.fire();
    return true;
  }
}

/** Flushes all currently-queued JS microtasks (macrotask boundary). */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Simulation harness
// ---------------------------------------------------------------------------

interface SimResult {
  effectiveMaxRpm: number;
  /** Virtual time each call was released (fn invoked), in submission order. */
  releaseTimes: number[];
  /** Virtual time each call was submitted (its offset), in submission order. */
  submitTimes: number[];
  /** How many times each call's fn ran (must be exactly 1). */
  runCounts: number[];
  /** Release order recorded as submission indices — must be 0,1,2,... */
  releaseOrder: number[];
  /** Every throttled event the throttle emitted. */
  events: ThrottleEvent[];
  /** Unique purpose string assigned to each call, by submission index. */
  purposes: string[];
}

/**
 * Drives one `ThrottleSchedule` to completion against a fresh simulated clock.
 *
 * Calls are submitted in ascending offset order (ties broken by original index)
 * — that ordering *is* the submission order, and the throttle's FIFO queue must
 * preserve it. Each call's `fn` records the release time (which equals `now()`
 * at invocation, since no timer fires between a release and its deferred `fn`)
 * and then "runs" for its generated duration via the same clock.
 */
async function simulate(schedule: {
  submissionOffsets: number[];
  durations: number[];
  maxRpm: number;
}): Promise<SimResult> {
  const clock = new SimClock();
  const events: ThrottleEvent[] = [];
  const effectiveMaxRpm = Math.max(1, Math.floor(schedule.maxRpm));

  const throttle = createLlmThrottle({
    maxRpm: schedule.maxRpm,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    emit: (event) => events.push(event),
  });

  const n = schedule.submissionOffsets.length;

  // Submission order = ascending offset, ties broken by original index.
  const plan = Array.from({ length: n }, (_, i) => ({
    index: i,
    offset: schedule.submissionOffsets[i] as number,
    duration: schedule.durations[i] as number,
  })).sort((a, b) => a.offset - b.offset || a.index - b.index);

  const releaseTimes: number[] = new Array<number>(n).fill(-1);
  const submitTimes: number[] = new Array<number>(n).fill(-1);
  const runCounts: number[] = new Array<number>(n).fill(0);
  const releaseOrder: number[] = [];
  const purposes: string[] = new Array<string>(n).fill("");
  const settled: Promise<unknown>[] = [];

  // Register each submission at its offset. `submissionIndex` is the position
  // in submission order, which is what every result array is keyed by.
  plan.forEach((item, submissionIndex) => {
    const purpose = `call-${submissionIndex}`;
    purposes[submissionIndex] = purpose;
    clock.at(item.offset, () => {
      submitTimes[submissionIndex] = clock.now();
      const promise = throttle.schedule(purpose, async () => {
        // now() here equals the release time: pump releases synchronously and
        // fires fn on the next microtask, before any further timer advances.
        releaseTimes[submissionIndex] = clock.now();
        runCounts[submissionIndex] = (runCounts[submissionIndex] ?? 0) + 1;
        releaseOrder.push(submissionIndex);
        // Model the call's own duration as elapsed virtual time.
        await clock.sleep(item.duration);
        return submissionIndex;
      });
      settled.push(promise);
    });
  });

  // Event loop: fire the earliest timer, then let the throttle react. A guard
  // bounds the loop far above any real schedule (submits + waits + durations).
  let guard = 0;
  const maxSteps = 10 * n + 100;
  await flushMicrotasks();
  while (clock.fireEarliest()) {
    await flushMicrotasks();
    guard += 1;
    if (guard > maxSteps) {
      throw new Error(`simulation did not converge within ${maxSteps} steps`);
    }
  }

  // Every scheduled call must have resolved.
  await Promise.all(settled);

  return {
    effectiveMaxRpm,
    releaseTimes,
    submitTimes,
    runCounts,
    releaseOrder,
    events,
    purposes,
  };
}

// ---------------------------------------------------------------------------
// Property 38
// ---------------------------------------------------------------------------

describe("Property 38: the LLM throttle never exceeds the per-minute ceiling", () => {
  it("keeps every trailing 60s window within maxRpm, runs each call once in order, and reports every wait", async () => {
    await fc.assert(
      fc.asyncProperty(arbThrottleSchedule, async (schedule) => {
        const result = await simulate(schedule);
        const n = schedule.submissionOffsets.length;

        // ---- Part 2a: every call ran exactly once. -----------------------
        expect(result.runCounts).toEqual(new Array<number>(n).fill(1));

        // ---- Part 2b: release order equals submission order. -------------
        expect(result.releaseOrder).toEqual(
          Array.from({ length: n }, (_, i) => i),
        );

        // A release never precedes its own submission.
        for (let i = 0; i < n; i += 1) {
          expect(result.releaseTimes[i]).toBeGreaterThanOrEqual(
            result.submitTimes[i] as number,
          );
        }

        // ---- Part 1: no trailing 60 000 ms window exceeds maxRpm. --------
        // The throttle gates on starts in the half-open window (c-WINDOW, c].
        // Checking that window ending at each recorded start captures the
        // rolling maximum, since starts are the only events.
        const starts = [...result.releaseTimes].sort((a, b) => a - b);
        for (let i = 0; i < starts.length; i += 1) {
          const windowEnd = starts[i] as number;
          const windowStart = windowEnd - WINDOW_MS;
          let count = 0;
          for (const s of starts) {
            if (s > windowStart && s <= windowEnd) count += 1;
          }
          expect(count).toBeLessThanOrEqual(result.effectiveMaxRpm);
        }

        // ---- Part 3: every waiting call emitted a matching event. --------
        const eventsByPurpose = new Map<string, ThrottleEvent[]>();
        for (const event of result.events) {
          const bucket = eventsByPurpose.get(event.purpose) ?? [];
          bucket.push(event);
          eventsByPurpose.set(event.purpose, bucket);
        }

        for (let i = 0; i < n; i += 1) {
          const waited =
            (result.releaseTimes[i] as number) - (result.submitTimes[i] as number);
          const purpose = result.purposes[i] as string;
          const emitted = eventsByPurpose.get(purpose) ?? [];

          if (waited > 0) {
            // Exactly one throttled event, carrying the exact wait.
            expect(emitted).toHaveLength(1);
            expect((emitted[0] as ThrottleEvent).waitMs).toBe(waited);
            expect((emitted[0] as ThrottleEvent).maxRpm).toBe(
              result.effectiveMaxRpm,
            );
          } else {
            // A call released immediately never announces a wait.
            expect(emitted).toHaveLength(0);
          }
        }

        // Every emitted event corresponds to a real, positive wait — the
        // throttle never fabricates a throttled event.
        for (const event of result.events) {
          expect(event.waitMs).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
