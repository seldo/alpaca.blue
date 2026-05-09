import { NextRequest, NextResponse } from "next/server";
import {
  fetchAndStoreBlueskyPosts,
  fetchAndStoreOwnMastodonPosts,
  getOwnIdentityIds,
  queryPostsByIdentities,
} from "@/lib/posts";
import { db } from "@/db";
import { platformIdentities, users, connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";

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

// Refresh the user's own platformIdentities with the rich profile blob from
// each platform. The bare ensureBlueskyOwnIdentity / fetchAndStoreOwnMastodon
// paths only stamp handle + displayName + avatar — bio and banner come from
// these dedicated profile endpoints. Failures are non-fatal (the page still
// renders with whatever's stored).
async function refreshOwnProfileData(userId: number) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return;

  const accounts = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId));

  const blueskyAccount = accounts.find((a) => a.platform === "bluesky");
  const mastodonAccount = accounts.find((a) => a.platform === "mastodon");

  const tasks: Promise<unknown>[] = [];

  if (blueskyAccount && user.blueskyDid) {
    tasks.push((async () => {
      const agent = await getServerBlueskyAgent(userId);
      if (!agent) return;
      const res = await agent.getProfile({ actor: user.blueskyDid });
      const p = res.data;
      await db
        .update(platformIdentities)
        .set({
          displayName: p.displayName ?? null,
          avatarUrl: p.avatar ?? null,
          bio: p.description ?? null,
          rawProfile: p as unknown as Record<string, unknown>,
        })
        .where(and(
          eq(platformIdentities.userId, userId),
          eq(platformIdentities.platform, "bluesky"),
          eq(platformIdentities.handle, blueskyAccount.handle),
        ));
    })().catch((err) => console.error("[profile] bluesky profile refresh failed:", err)));
  }

  if (mastodonAccount?.accessToken && mastodonAccount.instanceUrl) {
    tasks.push((async () => {
      const res = await fetch(
        `${mastodonAccount.instanceUrl}/api/v1/accounts/verify_credentials`,
        { headers: { Authorization: `Bearer ${mastodonAccount.accessToken}` } }
      );
      if (!res.ok) return;
      const p = await res.json();
      await db
        .update(platformIdentities)
        .set({
          displayName: p.display_name || null,
          avatarUrl: p.avatar || null,
          bio: p.note || null,
          rawProfile: p,
        })
        .where(and(
          eq(platformIdentities.userId, userId),
          eq(platformIdentities.platform, "mastodon"),
          eq(platformIdentities.handle, mastodonAccount.handle),
        ));
    })().catch((err) => console.error("[profile] mastodon profile refresh failed:", err)));
  }

  await Promise.allSettled(tasks);
}

// POST: store fresh posts from both platforms, return combined
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json().catch(() => ({}));
    const limit = Math.min(parseInt(body.limit || "50"), 100);

    await ensureBlueskyOwnIdentity(userId);

    await Promise.allSettled([
      fetchAndStoreBlueskyPosts(userId),
      fetchAndStoreOwnMastodonPosts(userId),
      refreshOwnProfileData(userId),
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
