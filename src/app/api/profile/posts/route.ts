import { NextRequest, NextResponse } from "next/server";
import {
  storeBlueskyPosts,
  fetchAndStoreOwnMastodonPosts,
  getOwnIdentityIds,
  queryPostsByIdentities,
} from "@/lib/posts";
import { db } from "@/db";
import { platformIdentities, users, connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// Ensure the user's own Bluesky platformIdentity exists before storing posts
async function ensureBlueskyOwnIdentity(userId: number) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.blueskyDid) return;

  const handle = user.blueskyHandle; // stored without @ for Bluesky, matching connectedAccounts
  await db.insert(platformIdentities).values({
    userId,
    platform: "bluesky",
    handle,
    did: user.blueskyDid,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profileUrl: `https://bsky.app/profile/${user.blueskyHandle}`,
    isFollowed: false,
  }).onDuplicateKeyUpdate({ set: { displayName: user.displayName, avatarUrl: user.avatarUrl } });
}

// POST: store fresh posts from both platforms, return combined
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const { posts: blueskyPosts } = body;
    const limit = Math.min(parseInt(body.limit || "50"), 100);

    await ensureBlueskyOwnIdentity(userId);

    await Promise.allSettled([
      blueskyPosts?.length > 0 ? storeBlueskyPosts(blueskyPosts, userId) : Promise.resolve(),
      fetchAndStoreOwnMastodonPosts(userId),
    ]);

    const identityIds = await getOwnIdentityIds(userId);
    console.log(`[profile] own identityIds: ${identityIds}`);
    const result = await queryPostsByIdentities(identityIds, { userId, limit });
    console.log(`[profile] returning ${result.posts.length} posts`);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Profile posts error:", err);
    return NextResponse.json({ error: "Failed to fetch profile posts" }, { status: 500 });
  }
}

// GET: load more (cursor pagination)
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);

    const identityIds = await getOwnIdentityIds(userId);
    const result = await queryPostsByIdentities(identityIds, { userId, cursor, limit });
    return NextResponse.json(result);
  } catch (err) {
    console.error("Profile posts error:", err);
    return NextResponse.json({ error: "Failed to fetch profile posts" }, { status: 500 });
  }
}
