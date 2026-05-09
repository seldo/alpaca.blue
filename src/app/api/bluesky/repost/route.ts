import { NextRequest, NextResponse } from "next/server";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const { uri, cid } = await request.json();
  if (!uri || !cid) {
    return NextResponse.json({ error: "uri and cid are required" }, { status: 400 });
  }

  const userId = session.userId!;
  const agent = await getServerBlueskyAgent(userId);
  if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

  try {
    await agent.repost(uri, cid);
    // Persist so the icon stays lit on next render before heartbeat refreshes.
    await db
      .update(posts)
      .set({ viewerReposted: true })
      .where(and(eq(posts.userId, userId), eq(posts.platformPostId, uri)))
      .catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bluesky/repost] failed:", err);
    const message = err instanceof Error ? err.message : "Failed to repost";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
