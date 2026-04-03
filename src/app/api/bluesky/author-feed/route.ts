import { NextRequest, NextResponse } from "next/server";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();
  const userId = session.userId!;

  const agent = await getServerBlueskyAgent(userId);
  if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

  const [user] = await db.select({ blueskyDid: users.blueskyDid }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.blueskyDid) return NextResponse.json({ feed: [] });

  const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
  const response = await agent.getAuthorFeed({ actor: user.blueskyDid, limit: 50, cursor });

  return NextResponse.json({ feed: response.data.feed, cursor: response.data.cursor });
}
