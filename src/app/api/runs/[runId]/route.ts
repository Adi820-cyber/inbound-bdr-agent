import { NextRequest, NextResponse } from "next/server";
import { createRunStore } from "@/store/run-store";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;

  if (!runId) {
    return NextResponse.json({ error: "Missing runId parameter" }, { status: 400 });
  }

  try {
    const store = createRunStore();
    const artifact = await store.get(runId);

    if (!artifact) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    return NextResponse.json(artifact, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to fetch run" }, { status: 500 });
  }
}
