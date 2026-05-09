import { NextRequest, NextResponse } from "next/server";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();
  const userId = session.userId!;

  const { uri, cid } = await request.json();
  if (!uri || !cid) {
    return NextResponse.json({ error: "uri and cid are required" }, { status: 400 });
  }

  const agent = await getServerBlueskyAgent(userId);
  if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

  await agent.like(uri, cid);
  // Persist so navigating away and back doesn't briefly un-illuminate the
  // heart while the next heartbeat refreshes the row.
  await db
    .update(posts)
    .set({ viewerLiked: true })
    .where(and(eq(posts.userId, userId), eq(posts.platformPostId, uri)))
    .catch(() => {});
  return NextResponse.json({ ok: true });
}
