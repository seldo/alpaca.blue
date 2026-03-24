import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, platformIdentities } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// Look up a post by platform URI. If it doesn't exist, create it from the
// provided quoted post data so we always have an internal /posts/[id] to show.
export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();
  const userId = session.userId!;

  const body = await request.json();
  const { uri, authorHandle, authorDisplayName, authorAvatar, text, media, postedAt } = body;

  if (!uri) {
    return NextResponse.json({ error: "uri required" }, { status: 400 });
  }

  // Check if we already have this post
  const [existing] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.userId, userId), eq(posts.platformPostId, uri)))
    .limit(1);

  if (existing) {
    return NextResponse.json({ id: existing.id });
  }

  // Post doesn't exist — create it from quoted post data
  // First, find or create a platform identity for the author
  let [identity] = await db
    .select({ id: platformIdentities.id })
    .from(platformIdentities)
    .where(
      and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "bluesky"),
        eq(platformIdentities.handle, authorHandle)
      )
    )
    .limit(1);

  if (!identity) {
    const [result] = await db.insert(platformIdentities).values({
      userId,
      platform: "bluesky",
      handle: authorHandle,
      displayName: authorDisplayName || null,
      avatarUrl: authorAvatar || null,
      profileUrl: `https://bsky.app/profile/${authorHandle}`,
      isFollowed: false,
    });
    identity = { id: result.insertId };
  }

  // Create the post
  const [result] = await db.insert(posts).values({
    userId,
    platformIdentityId: identity.id,
    platform: "bluesky",
    platformPostId: uri,
    content: text || "",
    postedAt: postedAt ? new Date(postedAt) : new Date(),
    media: media && media.length > 0 ? media : null,
  });

  return NextResponse.json({ id: result.insertId });
}
