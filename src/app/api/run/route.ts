import { NextRequest } from "next/server";
import { runPipeline } from "@/agent/orchestrator";
import type { StageEvent } from "@/agent/contracts";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    const text = await req.text();
    if (text) {
      body = JSON.parse(text);
    }
  } catch (_) {}

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;

      const safeEnqueue = (dataStr: string) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(dataStr));
        } catch (_) {
          isClosed = true;
        }
      };

      // 15-second heartbeat timer
      const heartbeatInterval = setInterval(() => {
        safeEnqueue(": ping\n\n");
      }, 15000);

      const onEvent = (event: StageEvent) => {
        const sseFrame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        safeEnqueue(sseFrame);
      };

      try {
        await runPipeline({
          rawEmail: body.rawEmail,
          onEvent,
        });
      } catch (err: any) {
        const errEvent: Partial<StageEvent> = {
          seq: 9999,
          eventId: "evt_err",
          type: "stage_failed",
          message: err?.message ?? "Unhandled pipeline error",
        };
        safeEnqueue(`event: stage_failed\ndata: ${JSON.stringify(errEvent)}\n\n`);
      } finally {
        clearInterval(heartbeatInterval);
        if (!isClosed) {
          try {
            controller.close();
          } catch (_) {}
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
