import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { redis, KEY_PREFIX } from "@/lib/redis";

export async function GET() {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId!))
    .limit(1);

  if (!user) {
    session.destroy();
    return unauthorizedResponse();
  }

  const hasBlueskySession = user.blueskyDid
    ? !!(await redis.exists(`${KEY_PREFIX}bluesky:session:${user.blueskyDid}`).catch(() => 1))
    : false;

  return NextResponse.json({
    id: user.id,
    blueskyDid: user.blueskyDid,
    blueskyHandle: user.blueskyHandle,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    needsReauth: !hasBlueskySession,
  });
}
