import { NextRequest, NextResponse } from "next/server";
import { queryTimeline } from "@/lib/posts";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const type = searchParams.get("type");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);

    const result = await queryTimeline(userId, { type, cursor, limit });
    return NextResponse.json(result);
  } catch (err) {
    console.error("Timeline error:", err);
    return NextResponse.json({ error: "Failed to fetch timeline" }, { status: 500 });
  }
}
