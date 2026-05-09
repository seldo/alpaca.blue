import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, platformIdentities, connectedAccounts } from "@/db/schema";
import { eq, lt, desc, and, isNull, isNotNull, sql } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { fetchAndStoreAuthorPostsForIdentity } from "@/lib/posts";
import {
  extractBannerUrl,
  extractStats,
  extractBlueskyFollowUri,
  bioToHtml,
  parseRawProfile,
} from "@/lib/profile-meta";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { redis, KEY_PREFIX } from "@/lib/redis";

const PROFILE_REFRESH_TTL = 60; // seconds

// Refreshes the identity's rawProfile (and bio/displayName/avatar) from the
// platform if we haven't done so recently. Bluesky's getFollows returns only
// the basic profile shape — banner, follower stats, and viewer.following all
// require a getProfile call. Mastodon's lookup returns the rich shape but we
// still need a periodic refresh so stats and viewer state stay current.
//
// Throttled via Redis (per identity) so the cost is at most one platform call
// per minute per visit.
async function refreshIdentityProfile(
  userId: number,
  identity: typeof platformIdentities.$inferSelect,
): Promise<typeof platformIdentities.$inferSelect> {
  const ttlKey = `${KEY_PREFIX}identity:profile_fetched:${identity.id}`;
  const recently = await redis.get<string>(ttlKey).catch(() => null);
  if (recently) return identity;

  try {
    if (identity.platform === "bluesky" && identity.did) {
      const agent = await getServerBlueskyAgent(userId);
      if (!agent) return identity;
      const res = await agent.getProfile({ actor: identity.did });
      const p = res.data;
      const updated = {
        displayName: p.displayName ?? identity.displayName,
        avatarUrl: p.avatar ?? identity.avatarUrl,
        bio: p.description ?? identity.bio,
        rawProfile: p as unknown as Record<string, unknown>,
      };
      await db
        .update(platformIdentities)
        .set(updated)
        .where(eq(platformIdentities.id, identity.id));
      await redis.set(ttlKey, "1", { ex: PROFILE_REFRESH_TTL }).catch(() => {});
      return { ...identity, ...updated };
    }
    if (identity.platform === "mastodon") {
      const [account] = await db
        .select()
        .from(connectedAccounts)
        .where(and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.platform, "mastodon"),
        ))
        .limit(1);
      if (!account?.accessToken || !account.instanceUrl) return identity;
      const lookupRes = await fetch(
        `${account.instanceUrl}/api/v1/accounts/lookup?acct=${encodeURIComponent(identity.handle.replace(/^@/, ""))}`,
        { headers: { Authorization: `Bearer ${account.accessToken}` } },
      );
      if (!lookupRes.ok) return identity;
      const p = await lookupRes.json();
      const updated = {
        displayName: p.display_name || identity.displayName,
        avatarUrl: p.avatar || identity.avatarUrl,
        bio: p.note || identity.bio,
        rawProfile: p,
      };
      await db
        .update(platformIdentities)
        .set(updated)
        .where(eq(platformIdentities.id, identity.id));
      await redis.set(ttlKey, "1", { ex: PROFILE_REFRESH_TTL }).catch(() => {});
      return { ...identity, ...updated };
    }
  } catch (err) {
    console.error("[identity refresh] failed:", err);
  }
  return identity;
}

// Mastodon stores relationship state separately from the account entity.
// Returns true when the user follows this identity. Returns null on failure
// — caller falls back to the row's stored isFollowed.
async function fetchMastodonFollowing(
  userId: number,
  rawProfile: unknown,
): Promise<boolean | null> {
  const r = parseRawProfile(rawProfile);
  if (!r) return null;
  const accountId = r.id;
  if (typeof accountId !== "string") return null;
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.userId, userId),
      eq(connectedAccounts.platform, "mastodon"),
    ))
    .limit(1);
  if (!account?.accessToken || !account.instanceUrl) return null;
  try {
    const res = await fetch(
      `${account.instanceUrl}/api/v1/accounts/relationships?id[]=${encodeURIComponent(accountId)}`,
      { headers: { Authorization: `Bearer ${account.accessToken}` } },
    );
    if (!res.ok) return null;
    const arr = await res.json();
    return Array.isArray(arr) && arr[0]?.following === true;
  } catch (err) {
    console.error("[mastodon relationship] failed:", err);
    return null;
  }
}

type Tab = "posts" | "replies" | "media" | "videos";

function parseTab(value: string | null): Tab {
  if (value === "replies" || value === "media" || value === "videos") return value;
  return "posts";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { id } = await params;
    const identityId = parseInt(id);
    if (isNaN(identityId)) {
      return NextResponse.json({ error: "Invalid identity ID" }, { status: 400 });
    }

    const [identityRow] = await db
      .select()
      .from(platformIdentities)
      .where(and(eq(platformIdentities.id, identityId), eq(platformIdentities.userId, userId)))
      .limit(1);

    if (!identityRow) {
      return NextResponse.json({ error: "Identity not found" }, { status: 404 });
    }

    const identity = await refreshIdentityProfile(userId, identityRow);

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const tab = parseTab(searchParams.get("tab"));

    // Pull a fresh page from the platform before reading the DB. Reset the
    // per-identity cursor on a fresh visit so we start from the latest;
    // otherwise advance through the author's history.
    await fetchAndStoreAuthorPostsForIdentity(
      userId,
      { id: identity.id, platform: identity.platform, did: identity.did, handle: identity.handle },
      { reset: !cursor },
    ).catch(() => {});

    const conditions = [
      eq(posts.platformIdentityId, identityId),
      eq(posts.userId, userId),
    ];
    if (cursor) {
      conditions.push(lt(posts.postedAt, new Date(cursor)));
    }
    if (tab === "posts") {
      conditions.push(isNull(posts.replyToId));
    } else if (tab === "replies") {
      conditions.push(isNotNull(posts.replyToId));
    } else if (tab === "media") {
      // Stored media is a JSON array; "non-empty" === at least one element.
      conditions.push(sql`json_length(${posts.media}) > 0`);
    } else if (tab === "videos") {
      conditions.push(sql`json_search(${posts.media}, 'one', 'video', null, '$[*].type') is not null`);
    }

    const rows = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.postedAt))
      .limit(limit);

    const result = rows.map((post) => ({
      id: post.id,
      platform: post.platform,
      platformPostId: post.platformPostId,
      platformPostCid: post.platformPostCid || null,
      postUrl: post.postUrl || null,
      content: post.content,
      contentHtml: post.contentHtml,
      media: typeof post.media === "string" ? JSON.parse(post.media) : post.media,
      replyToId: post.replyToId,
      repostOfId: post.repostOfId,
      quotedPost: typeof post.quotedPost === "string" ? JSON.parse(post.quotedPost) : post.quotedPost,
      linkCard: typeof post.linkCard === "string" ? JSON.parse(post.linkCard) : post.linkCard,
      likeCount: post.likeCount,
      repostCount: post.repostCount,
      replyCount: post.replyCount,
      viewerLiked: !!post.viewerLiked,
      viewerReposted: !!post.viewerReposted,
      postedAt: post.postedAt.toISOString(),
      author: {
        id: identity.id,
        handle: identity.handle,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        platform: identity.platform,
        profileUrl: identity.profileUrl,
      },
      person: null,
      alsoPostedOn: [],
    }));

    const nextCursor =
      result.length === limit ? result[result.length - 1].postedAt : null;

    // Determine follow state. Bluesky surfaces it inside rawProfile.viewer;
    // Mastodon needs a separate relationships call which we run only when we
    // didn't already detect a refresh-skip (otherwise it's already ~accurate).
    let isFollowing: boolean;
    if (identity.platform === "bluesky") {
      isFollowing = !!extractBlueskyFollowUri(identity.rawProfile);
    } else if (identity.platform === "mastodon") {
      const live = await fetchMastodonFollowing(userId, identity.rawProfile);
      isFollowing = live ?? !!identity.isFollowed;
    } else {
      isFollowing = !!identity.isFollowed;
    }

    const identityResponse = {
      id: identity.id,
      platform: identity.platform,
      handle: identity.handle,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      profileUrl: identity.profileUrl,
      personId: identity.personId,
      bio: identity.bio,
      bioHtml: bioToHtml(identity.platform, identity.bio),
      bannerUrl: extractBannerUrl(identity.platform, identity.rawProfile),
      stats: extractStats(identity.platform, identity.rawProfile),
      isFollowing,
    };

    return NextResponse.json({ identity: identityResponse, posts: result, nextCursor });
  } catch (err) {
    console.error("Identity posts error:", err);
    return NextResponse.json({ error: "Failed to fetch identity posts" }, { status: 500 });
  }
}
