import { NextRequest, NextResponse } from "next/server";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const { uri, cid } = await request.json();
  if (!uri || !cid) {
    return NextResponse.json({ error: "uri and cid are required" }, { status: 400 });
  }

  const agent = await getServerBlueskyAgent(session.userId!);
  if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

  try {
    await agent.repost(uri, cid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bluesky/repost] failed:", err);
    const message = err instanceof Error ? err.message : "Failed to repost";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
