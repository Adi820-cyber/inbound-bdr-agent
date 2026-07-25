"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  RawEmailRecord,
  RunArtifact,
  RunStatus,
  StageEvent,
  StageNumber,
  StageStatus,
} from "@/agent/contracts";

export interface StageState {
  status: StageStatus;
  output: unknown;
  events: StageEvent[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface RunStreamState {
  runId: string | null;
  runStatus: RunStatus | "idle";
  stages: Record<StageNumber, StageState>;
  events: StageEvent[];
  lastSeq: number;
  isInterrupted: boolean;
  artifact: RunArtifact | null;
  error: string | null;
  startTime: number | null;
  elapsedMs: number;
  lastRawEmail?: RawEmailRecord;
}

type Action =
  | { type: "START_RUN"; runId?: string; rawEmail?: RawEmailRecord }
  | { type: "PROCESS_EVENT"; event: StageEvent }
  | { type: "SET_INTERRUPTED" }
  | { type: "SET_ARTIFACT"; artifact: RunArtifact }
  | { type: "SET_ERROR"; error: string }
  | { type: "TICK_ELAPSED"; now: number };

const initialStageState = (): StageState => ({
  status: "pending",
  output: null,
  events: [],
});

const initialState: RunStreamState = {
  runId: null,
  runStatus: "idle",
  stages: {
    1: initialStageState(),
    2: initialStageState(),
    3: initialStageState(),
    4: initialStageState(),
    5: initialStageState(),
    6: initialStageState(),
  },
  events: [],
  lastSeq: 0,
  isInterrupted: false,
  artifact: null,
  error: null,
  startTime: null,
  elapsedMs: 0,
};

const isTerminal = (status: StageStatus) => status === "complete" || status === "failed";

/**
 * Hydrate per-stage state from a loaded RunArtifact.
 * Used when reloading a run via GET /api/runs/[runId].
 */
function hydrateStagesFromArtifact(artifact: RunArtifact): Record<StageNumber, StageState> {
  const stageKeys: readonly (keyof RunArtifact["stages"])[] = [
    "stage1", "stage2", "stage3", "stage4", "stage5", "stage6",
  ] as const;

  const stageNums: readonly StageNumber[] = [1, 2, 3, 4, 5, 6] as const;

  const stages = {} as Record<StageNumber, StageState>;
  for (let i = 0; i < stageNums.length; i++) {
    const num = stageNums[i]!;
    const key = stageKeys[i]!;
    const record = artifact.stages[key];
    const stageEvents = artifact.events.filter((e) => e.stage === num);
    stages[num] = {
      status: record.status,
      output: record.output,
      events: stageEvents,
      startedAt: record.startedAt !== "unknown" ? record.startedAt : undefined,
      completedAt: record.completedAt !== "unknown" ? record.completedAt : undefined,
      durationMs: record.durationMs !== "unknown" ? record.durationMs : undefined,
    };
  }
  return stages;
}

export function streamReducer(state: RunStreamState, action: Action): RunStreamState {
  switch (action.type) {
    case "START_RUN":
      return {
        ...initialState,
        runStatus: "running",
        startTime: Date.now(),
        lastRawEmail: action.rawEmail,
      };

    case "TICK_ELAPSED":
      if (state.runStatus !== "running" || !state.startTime) return state;
      return {
        ...state,
        elapsedMs: action.now - state.startTime,
      };

    case "SET_INTERRUPTED":
      return {
        ...state,
        isInterrupted: true,
        runStatus: state.runStatus === "running" ? "failed" : state.runStatus,
      };

    case "SET_ARTIFACT":
      return {
        ...state,
        artifact: action.artifact,
        runId: action.artifact.runId,
        runStatus: action.artifact.status,
        events: action.artifact.events,
        stages: hydrateStagesFromArtifact(action.artifact),
        isInterrupted: false,
      };

    case "SET_ERROR":
      return {
        ...state,
        error: action.error,
        runStatus: "failed",
      };

    case "PROCESS_EVENT": {
      const { event } = action;
      // Deduplicate by seq
      if (state.events.some((e) => e.seq === event.seq)) {
        return state;
      }

      const nextEvents = [...state.events, event].sort((a, b) => a.seq - b.seq);
      const nextLastSeq = Math.max(state.lastSeq, event.seq);
      const nextRunId = state.runId ?? event.runId;

      let nextRunStatus = state.runStatus;
      if (event.type === "run_started") nextRunStatus = "running";
      if (event.type === "run_completed") {
        const hasFailedStage = Object.values(state.stages).some((s) => s.status === "failed");
        nextRunStatus = hasFailedStage ? "partial" : "complete";
      }

      const nextStages = { ...state.stages };

      if (event.stage && event.stage >= 1 && event.stage <= 6) {
        const stageNum = event.stage as StageNumber;
        const currentStage = nextStages[stageNum];

        let newStatus = currentStage.status;

        if (!isTerminal(currentStage.status)) {
          if (event.type === "stage_started") newStatus = "running";
          if (event.type === "stage_completed") newStatus = "complete";
          if (event.type === "stage_failed") newStatus = "failed";
        }

        const newStageEvents = [...currentStage.events, event].sort((a, b) => a.seq - b.seq);

        nextStages[stageNum] = {
          ...currentStage,
          status: newStatus,
          output: event.output !== undefined ? event.output : currentStage.output,
          events: newStageEvents,
          durationMs: event.durationMs ?? currentStage.durationMs,
        };
      }

      return {
        ...state,
        runId: nextRunId,
        runStatus: nextRunStatus,
        lastSeq: nextLastSeq,
        events: nextEvents,
        stages: nextStages,
      };
    }

    default:
      return state;
  }
}

export function useRunStream() {
  const [state, dispatch] = useReducer(streamReducer, initialState);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Timer interval for elapsed time
  useEffect(() => {
    if (state.runStatus !== "running") return;
    const interval = setInterval(() => {
      dispatch({ type: "TICK_ELAPSED", now: Date.now() });
    }, 200);
    return () => clearInterval(interval);
  }, [state.runStatus]);

  const triggerRun = useCallback(async (rawEmail?: RawEmailRecord) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    dispatch({ type: "START_RUN", rawEmail });

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawEmail }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        dispatch({ type: "SET_ERROR", error: `HTTP ${res.status}: Failed to start pipeline` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.trim() || frame.startsWith(":")) continue; // ignore ping/heartbeats

          const lines = frame.split("\n");
          let dataStr = "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              dataStr = line.slice(6).trim();
            }
          }

          if (dataStr) {
            try {
              const event: StageEvent = JSON.parse(dataStr);
              dispatch({ type: "PROCESS_EVENT", event });
            } catch {
              // Ignore malformed JSON
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        dispatch({ type: "SET_INTERRUPTED" });
      }
    }
  }, []);

  const reloadRun = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (res.ok) {
        const artifact: RunArtifact = await res.json();
        dispatch({ type: "SET_ARTIFACT", artifact });
      } else {
        dispatch({ type: "SET_ERROR", error: `Run ${runId} not found (HTTP ${res.status})` });
      }
    } catch {
      dispatch({ type: "SET_ERROR", error: `Failed to load run ${runId}` });
    }
  }, []);

  const retryRun = useCallback(() => {
    triggerRun(state.lastRawEmail);
  }, [triggerRun, state.lastRawEmail]);

  return {
    state,
    triggerRun,
    reloadRun,
    retryRun,
  };
}
