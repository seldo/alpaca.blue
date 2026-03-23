import { NextResponse } from "next/server";
import { runResolutionPipeline } from "@/lib/identity-resolution";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const stats = await runResolutionPipeline(userId);
    return NextResponse.json(stats);
  } catch (err) {
    console.error("Resolution pipeline error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Resolution failed" },
      { status: 500 }
    );
  }
}
