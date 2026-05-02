import { db } from "@/db";
import {
  posts,
  platformIdentities,
  connectedAccounts,
  persons,
  users,
} from "@/db/schema";
import { eq, and, lt, desc, isNull, inArray, sql } from "drizzle-orm";
import { createHash } from "crypto";
import { redis, keys, TTL } from "@/lib/redis";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";

// ── Types ──────────────────────────────────────────────────

export interface QuotedPostData {
  uri: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  text: string;
  media?: Array<{ type: string; url: string; alt: string; thumbnailUrl?: string }>;
  postedAt?: string;
}

export interface LinkCardData {
  url: string;
  title: string;
  description?: string;
  thumb?: string;
}

export interface BlueskyPostData {
  uri: string;
  cid?: string;
  authorDid: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  text: string;
  contentHtml?: string;
  createdAt: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  replyToUri?: string;
  threadRootUri?: string;
  threadRootCid?: string;
  repostOfUri?: string;
  repostedByHandle?: string;
  media?: Array<{ type: string; url: string; alt: string; thumbnailUrl?: string }>;
  quotedPost?: QuotedPostData;
  linkCard?: LinkCardData;
  isMention?: boolean;
}

interface MastodonStatus {
  id: string;
  url: string; // canonical URL on the author's instance
  content: string;
  created_at: string;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  in_reply_to_id: string | null;
  reblog: MastodonStatus | null;
  account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
    url: string;
  };
  media_attachments: Array<{
    type: string;
    url: string;
    preview_url?: string | null;
    description: string | null;
  }>;
}

// ── Dedup hash ─────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  return html
    // Replace <br> with space
    .replace(/<br\s*\/?>/gi, " ")
    // Replace <a> tags with their href (Mastodon wraps URLs in spans that break them)
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, " $1 ")
    // Strip remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeDedupeHash(
  content: string,
): string | null {
  // Normalize: lowercase, strip all URLs, collapse whitespace, take first 100 chars
  const normalized = content
    .toLowerCase()
    // Full URLs
    .replace(/https?:\/\/\S+/g, "")
    // Bare domain URLs (e.g. "example.com/path..." from Bluesky truncation)
    .replace(/\b[\w-]+\.[\w-]+\.\w{2,}\/\S*/g, "")
    .replace(/\b[\w-]+\.\w{2,}\/\S*/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  if (normalized.length < 20) return null;

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Store Bluesky posts ────────────────────────────────────

export async function storeBlueskyPosts(
  postsData: BlueskyPostData[],
  userId: number
): Promise<{ stored: number }> {
  if (postsData.length === 0) return { stored: 0 };

  const t0 = Date.now();

  // Fetch all known identities in one query by DID
  const allDids = [...new Set(postsData.map((p) => p.authorDid))];
  const identityRows = await db
    .select()
    .from(platformIdentities)
    .where(
      and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "bluesky"),
        inArray(platformIdentities.did, allDids)
      )
    );

  const identityMap = new Map(identityRows.map((i) => [i.did!, i]));

  // Insert new mention identities (people who mentioned us but aren't followed)
  const missingMentions = postsData.filter(
    (p) => p.isMention && !identityMap.has(p.authorDid)
  );
  if (missingMentions.length > 0) {
    const newRows = missingMentions.map((post) => ({
      userId,
      platform: "bluesky" as const,
      handle: post.authorHandle,
      did: post.authorDid,
      displayName: post.authorDisplayName || null,
      avatarUrl: post.authorAvatar || null,
      profileUrl: `https://bsky.app/profile/${post.authorHandle}`,
      isFollowed: false,
    }));
    await db.insert(platformIdentities).values(newRows).onDuplicateKeyUpdate({
      set: {
        handle: sql`values(${platformIdentities.handle})`,
        displayName: sql`values(${platformIdentities.displayName})`,
        avatarUrl: sql`values(${platformIdentities.avatarUrl})`,
      },
    });
    const newDids = [...new Set(missingMentions.map((p) => p.authorDid))];
    const insertedRows = await db.select().from(platformIdentities).where(
      and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "bluesky"),
        inArray(platformIdentities.did, newDids)
      )
    );
    for (const row of insertedRows) {
      identityMap.set(row.did!, row);
    }
  }


  // Build all post rows in memory
  const rows = [];
  for (const post of postsData) {
    const identity = identityMap.get(post.authorDid);
    if (!identity) continue; // Skip timeline posts from unknown authors

    const media = post.media;
    rows.push({
      userId,
      isTimeline: !post.isMention,
      isMention: !!post.isMention,
      platformIdentityId: identity.id,
      platform: "bluesky" as const,
      platformPostId: post.uri,
      platformPostCid: post.cid || null,
      content: post.text || "",
      contentHtml: post.contentHtml || null,
      media: media && media.length > 0 ? media : null,
      replyToId: post.replyToUri || null,
      threadRootId: post.threadRootUri || null,
      threadRootCid: post.threadRootCid || null,
      repostOfId: post.repostOfUri || null,
      quotedPost: post.quotedPost || null,
      linkCard: post.linkCard ? JSON.stringify(post.linkCard) : null,
      likeCount: post.likeCount || 0,
      repostCount: post.repostCount || 0,
      replyCount: post.replyCount || 0,
      postedAt: new Date(post.createdAt),
      dedupeHash: computeDedupeHash(post.text || ""),
    });
  }

  // Single batch upsert — OR the boolean flags so a mention upsert doesn't clear isTimeline
  if (rows.length > 0) {
    await db.insert(posts).values(rows).onDuplicateKeyUpdate({
      set: {
        isTimeline: sql`greatest(${posts.isTimeline}, values(${posts.isTimeline}))`,
        isMention: sql`greatest(${posts.isMention}, values(${posts.isMention}))`,
        content: sql`values(${posts.content})`,
        contentHtml: sql`values(${posts.contentHtml})`,
        platformPostCid: sql`values(${posts.platformPostCid})`,
        media: sql`values(${posts.media})`,
        quotedPost: sql`values(${posts.quotedPost})`,
        linkCard: sql`values(${posts.linkCard})`,
        replyToId: sql`values(${posts.replyToId})`,
        threadRootId: sql`values(${posts.threadRootId})`,
        threadRootCid: sql`values(${posts.threadRootCid})`,
        likeCount: sql`values(${posts.likeCount})`,
        repostCount: sql`values(${posts.repostCount})`,
        replyCount: sql`values(${posts.replyCount})`,
        fetchedAt: new Date(),
      },
    });
  }

  if (rows.length > 0) {
    await redis.del(keys.timelineCache(userId, "timeline")).catch(() => {});
  }

  console.log(`[bluesky] DB ops (${postsData.length} posts, ${rows.length} rows): ${Date.now() - t0}ms`);
  return { stored: rows.length };
}

// ── Fetch & store Mastodon posts ───────────────────────────

export async function fetchAndStoreMastodonPosts(
  userId: number
): Promise<{ stored: number }> {
  const debounceKey = keys.mastodonFetched(userId, "timeline");
  const recentlyFetched = await redis.get(debounceKey).catch(() => null);
  if (recentlyFetched) {
    console.log(`[mastodon] timeline fetch skipped (debounced)`);
    return { stored: 0 };
  }

  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) {
    throw new Error("Not authenticated with Mastodon");
  }

  const instanceUrl = account.instanceUrl;
  const instanceHost = new URL(instanceUrl).hostname;

  const t0 = Date.now();
  const response = await fetch(`${instanceUrl}/api/v1/timelines/home?limit=40`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
  console.log(`[mastodon] timeline API fetch: ${Date.now() - t0}ms`);

  if (!response.ok) {
    throw new Error(`Mastodon timeline fetch failed: ${response.status}`);
  }

  const statuses: MastodonStatus[] = await response.json();
  const tDb = Date.now();

  // Collect all handles, then fetch all identities in one query
  const handleOf = (acct: string) =>
    acct.includes("@") ? `@${acct}` : `@${acct}@${instanceHost}`;

  const allHandles = [...new Set(
    statuses.map((s) => handleOf((s.reblog || s).account.acct))
  )];

  const identityRows = allHandles.length > 0
    ? await db.select().from(platformIdentities).where(
        and(
          eq(platformIdentities.userId, userId),
          eq(platformIdentities.platform, "mastodon"),
          inArray(platformIdentities.handle, allHandles)
        )
      )
    : [];

  const identityMap = new Map(identityRows.map((i) => [i.handle, i]));

  // Build all post rows in memory
  const rows = [];
  for (const status of statuses) {
    const actual = status.reblog || status;
    const handle = handleOf(actual.account.acct);
    const identity = identityMap.get(handle);
    if (!identity) continue;

    const plainContent = stripHtmlTags(actual.content);
    const media = actual.media_attachments.map((m) => ({
      type: m.type,
      url: m.url,
      alt: m.description || "",
      thumbnailUrl: m.preview_url || undefined,
    }));

    rows.push({
      userId,
      isTimeline: true,
      isMention: false,
      platformIdentityId: identity.id,
      platform: "mastodon" as const,
      platformPostId: actual.id,
      postUrl: actual.url || null,
      content: plainContent,
      contentHtml: actual.content,
      media: media.length > 0 ? media : null,
      replyToId: actual.in_reply_to_id || null,
      repostOfId: status.reblog ? status.id : null,
      likeCount: actual.favourites_count || 0,
      repostCount: actual.reblogs_count || 0,
      replyCount: actual.replies_count || 0,
      postedAt: new Date(actual.created_at),
      dedupeHash: computeDedupeHash(plainContent),
    });
  }

  // Single batch upsert
  if (rows.length > 0) {
    await db.insert(posts).values(rows).onDuplicateKeyUpdate({
      set: {
        isTimeline: true,
        content: sql`values(${posts.content})`,
        contentHtml: sql`values(${posts.contentHtml})`,
        postUrl: sql`values(${posts.postUrl})`,
        likeCount: sql`values(${posts.likeCount})`,
        repostCount: sql`values(${posts.repostCount})`,
        replyCount: sql`values(${posts.replyCount})`,
        fetchedAt: new Date(),
      },
    });
  }

  await redis.set(debounceKey, "1", { ex: TTL.mastodonFetchDebounce }).catch(() => {});
  if (rows.length > 0) {
    await redis.del(keys.timelineCache(userId, "timeline")).catch(() => {});
  }

  console.log(`[mastodon] DB ops (${statuses.length} statuses, ${rows.length} rows): ${Date.now() - tDb}ms`);
  return { stored: rows.length };
}

// ── Fetch & store Mastodon mentions ──────────────────────

interface MastodonNotification {
  id: string;
  type: string; // "mention", "favourite", "reblog", "follow", etc.
  created_at: string;
  status: MastodonStatus | null;
}

export async function fetchAndStoreMastodonMentions(
  userId: number
): Promise<{ stored: number }> {
  const debounceKey = keys.mastodonFetched(userId, "mentions");
  const recentlyFetched = await redis.get(debounceKey).catch(() => null);
  if (recentlyFetched) {
    console.log(`[mastodon] mentions fetch skipped (debounced)`);
    return { stored: 0 };
  }

  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) {
    throw new Error("Not authenticated with Mastodon");
  }

  const instanceUrl = account.instanceUrl;
  const instanceHost = new URL(instanceUrl).hostname;

  const t0 = Date.now();
  const response = await fetch(
    `${instanceUrl}/api/v1/notifications?types[]=mention&limit=40`,
    { headers: { Authorization: `Bearer ${account.accessToken}` } }
  );
  console.log(`[mastodon] mentions API fetch: ${Date.now() - t0}ms`);

  if (!response.ok) {
    throw new Error(`Mastodon mentions fetch failed: ${response.status}`);
  }

  const notifications: MastodonNotification[] = await response.json();
  const statuses = notifications.map((n) => n.status).filter(Boolean) as MastodonStatus[];
  const tDb = Date.now();

  const handleOf = (acct: string) =>
    acct.includes("@") ? `@${acct}` : `@${acct}@${instanceHost}`;

  // Fetch all known identities in one query
  const allHandles = [...new Set(statuses.map((s) => handleOf(s.account.acct)))];
  const identityRows = allHandles.length > 0
    ? await db.select().from(platformIdentities).where(
        and(
          eq(platformIdentities.userId, userId),
          eq(platformIdentities.platform, "mastodon"),
          inArray(platformIdentities.handle, allHandles)
        )
      )
    : [];

  const identityMap = new Map(identityRows.map((i) => [i.handle, i]));

  // Insert any missing identities (people who mentioned us but aren't followed)
  const missingStatuses = statuses.filter((s) => !identityMap.has(handleOf(s.account.acct)));
  if (missingStatuses.length > 0) {
    const newIdentityRows = missingStatuses.map((s) => ({
      userId,
      platform: "mastodon" as const,
      handle: handleOf(s.account.acct),
      did: s.account.id,
      displayName: s.account.display_name || null,
      avatarUrl: s.account.avatar || null,
      profileUrl: s.account.url,
      isFollowed: false,
    }));
    await db.insert(platformIdentities).values(newIdentityRows).onDuplicateKeyUpdate({
      set: {
        did: sql`values(${platformIdentities.did})`,
        displayName: sql`values(${platformIdentities.displayName})`,
        avatarUrl: sql`values(${platformIdentities.avatarUrl})`,
      },
    });
    const newHandles = newIdentityRows.map((r) => r.handle);
    const insertedRows = await db.select().from(platformIdentities).where(
      and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "mastodon"),
        inArray(platformIdentities.handle, newHandles)
      )
    );
    for (const row of insertedRows) {
      identityMap.set(row.handle, row);
    }
  }

  // Build all post rows in memory
  const rows = [];
  for (const status of statuses) {
    const handle = handleOf(status.account.acct);
    const identity = identityMap.get(handle);
    if (!identity) continue;

    const plainContent = stripHtmlTags(status.content);
    const media = status.media_attachments.map((m) => ({
      type: m.type,
      url: m.url,
      alt: m.description || "",
    }));

    rows.push({
      userId,
      isTimeline: false,
      isMention: true,
      platformIdentityId: identity.id,
      platform: "mastodon" as const,
      platformPostId: status.id,
      postUrl: status.url || null,
      content: plainContent,
      contentHtml: status.content,
      media: media.length > 0 ? media : null,
      replyToId: status.in_reply_to_id || null,
      likeCount: status.favourites_count || 0,
      repostCount: status.reblogs_count || 0,
      replyCount: status.replies_count || 0,
      postedAt: new Date(status.created_at),
      dedupeHash: computeDedupeHash(plainContent),
    });
  }

  // Single batch upsert — include replyToId so it gets corrected if it was null on first insert
  if (rows.length > 0) {
    await db.insert(posts).values(rows).onDuplicateKeyUpdate({
      set: {
        isMention: true,
        content: sql`values(${posts.content})`,
        contentHtml: sql`values(${posts.contentHtml})`,
        postUrl: sql`values(${posts.postUrl})`,
        replyToId: sql`values(${posts.replyToId})`,
        likeCount: sql`values(${posts.likeCount})`,
        repostCount: sql`values(${posts.repostCount})`,
        replyCount: sql`values(${posts.replyCount})`,
        fetchedAt: new Date(),
      },
    });
  }

  await redis.set(debounceKey, "1", { ex: TTL.mastodonFetchDebounce }).catch(() => {});
  if (rows.length > 0) {
    await redis.del(keys.timelineCache(userId, "mentions")).catch(() => {});
  }

  console.log(`[mastodon] DB ops (${statuses.length} mentions, ${rows.length} rows): ${Date.now() - tDb}ms`);
  return { stored: rows.length };
}

// ── Fetch & store user's own Mastodon posts ────────────────

export async function fetchAndStoreOwnMastodonPosts(
  userId: number
): Promise<{ stored: number; identityId: number | null }> {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl || !account.did) {
    return { stored: 0, identityId: null };
  }

  // Find or create the user's own Mastodon platformIdentity
  let [identity] = await db.select().from(platformIdentities).where(
    and(
      eq(platformIdentities.userId, userId),
      eq(platformIdentities.platform, "mastodon"),
      eq(platformIdentities.handle, account.handle)
    )
  ).limit(1);

  if (!identity) {
    const [result] = await db.insert(platformIdentities).values({
      userId,
      platform: "mastodon",
      handle: account.handle,
      did: account.did,
      profileUrl: `${account.instanceUrl}/@${account.handle.split("@")[1]}`,
      isFollowed: false,
    }).onDuplicateKeyUpdate({ set: { did: account.did } });
    identity = { id: result.insertId } as typeof identity;
  }

  const response = await fetch(
    `${account.instanceUrl}/api/v1/accounts/${account.did}/statuses?limit=40&exclude_replies=false`,
    { headers: { Authorization: `Bearer ${account.accessToken}` } }
  );

  if (!response.ok) return { stored: 0, identityId: identity.id };

  const statuses: MastodonStatus[] = await response.json();

  const rows = statuses.map((status) => {
    const actual = status.reblog || status;
    const plainContent = stripHtmlTags(actual.content);
    const media = actual.media_attachments.map((m) => ({ type: m.type, url: m.url, alt: m.description || "", thumbnailUrl: m.preview_url || undefined }));
    return {
      userId,
      isTimeline: true,
      isMention: false,
      platformIdentityId: identity.id,
      platform: "mastodon" as const,
      platformPostId: actual.id,
      postUrl: actual.url || null,
      content: plainContent,
      contentHtml: actual.content,
      media: media.length > 0 ? media : null,
      replyToId: actual.in_reply_to_id || null,
      repostOfId: status.reblog ? status.id : null,
      likeCount: actual.favourites_count || 0,
      repostCount: actual.reblogs_count || 0,
      replyCount: actual.replies_count || 0,
      postedAt: new Date(actual.created_at),
      dedupeHash: computeDedupeHash(plainContent),
    };
  });

  if (rows.length > 0) {
    await db.insert(posts).values(rows).onDuplicateKeyUpdate({
      set: {
        content: sql`values(${posts.content})`,
        contentHtml: sql`values(${posts.contentHtml})`,
        postUrl: sql`values(${posts.postUrl})`,
        likeCount: sql`values(${posts.likeCount})`,
        repostCount: sql`values(${posts.repostCount})`,
        replyCount: sql`values(${posts.replyCount})`,
        fetchedAt: new Date(),
      },
    });
  }

  return { stored: rows.length, identityId: identity.id };
}

// ── Fetch Mastodon reactions (likes, reposts, follows) ────

import type { RawReaction } from "@/lib/reactions";

export async function fetchMastodonReactions(
  userId: number
): Promise<RawReaction[]> {
  const cacheKey = keys.mastodonReactions(userId);
  const cached = await redis.get<RawReaction[]>(cacheKey).catch(() => null);
  if (cached) {
    console.log("[mastodon] reactions cache hit");
    return cached;
  }

  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) return [];

  const instanceUrl = account.instanceUrl;
  const instanceHost = new URL(instanceUrl).hostname;

  const response = await fetch(
    `${instanceUrl}/api/v1/notifications?types[]=favourite&types[]=reblog&types[]=follow&limit=50`,
    { headers: { Authorization: `Bearer ${account.accessToken}` } }
  );

  if (!response.ok) return [];

  const notifications: Array<{
    id: string;
    type: string;
    created_at: string;
    account: { id: string; username: string; acct: string; display_name: string; avatar: string };
    status?: { id: string; url: string; content: string };
  }> = await response.json();

  const filtered = notifications.filter(
    (n) => n.type === "favourite" || n.type === "reblog" || n.type === "follow"
  );

  // Look up internal post IDs for subject statuses
  const statusIds = [...new Set(
    filtered.map((n) => n.status?.id).filter((id): id is string => !!id)
  )];
  const internalIdMap = new Map<string, number>(); // mastodon status id -> internal post id
  if (statusIds.length > 0) {
    const rows = await db
      .select({ id: posts.id, platformPostId: posts.platformPostId })
      .from(posts)
      .where(and(eq(posts.userId, userId), inArray(posts.platformPostId, statusIds)));
    for (const row of rows) {
      internalIdMap.set(row.platformPostId, row.id);
    }
  }

  // Batch-lookup in-app platform identities for reactors so the UI can link to /persons or /identities.
  // Mastodon handles are stored as @user@instance — build that for every reactor first.
  const reactorHandles = [
    ...new Set(
      filtered.map((n) =>
        n.account.acct.includes("@") ? `@${n.account.acct}` : `@${n.account.acct}@${instanceHost}`
      )
    ),
  ];
  const reactorIdentityByHandle = new Map<string, { id: number; personId: number | null }>();
  if (reactorHandles.length > 0) {
    const rows = await db
      .select({ id: platformIdentities.id, handle: platformIdentities.handle, personId: platformIdentities.personId })
      .from(platformIdentities)
      .where(and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "mastodon"),
        inArray(platformIdentities.handle, reactorHandles)
      ));
    for (const row of rows) {
      reactorIdentityByHandle.set(row.handle, { id: row.id, personId: row.personId });
    }
  }

  const reactions = filtered.map((n) => {
      const handle = n.account.acct.includes("@")
        ? `@${n.account.acct}`
        : `@${n.account.acct}@${instanceHost}`;

      const identity = reactorIdentityByHandle.get(handle);
      const reactor = {
        handle,
        displayName: n.account.display_name || n.account.username,
        avatarUrl: n.account.avatar,
        platformIdentityId: identity?.id ?? null,
        personId: identity?.personId ?? null,
      };

      const internalId = n.status?.id ? internalIdMap.get(n.status.id) : undefined;
      const subjectUrl = internalId ? `/posts/${internalId}` : null;

      if (n.type === "favourite") {
        return {
          platform: "mastodon" as const,
          reactionType: "like" as const,
          subjectId: n.status?.id ?? null,
          subjectExcerpt: n.status ? stripHtmlTags(n.status.content) : null,
          subjectUrl,
          reactor,
          reactedAt: n.created_at,
        };
      } else if (n.type === "reblog") {
        return {
          platform: "mastodon" as const,
          reactionType: "repost" as const,
          subjectId: n.status?.id ?? null,
          subjectExcerpt: n.status ? stripHtmlTags(n.status.content) : null,
          subjectUrl,
          reactor,
          reactedAt: n.created_at,
        };
      } else {
        return {
          platform: "mastodon" as const,
          reactionType: "follow" as const,
          subjectId: null,
          subjectExcerpt: null,
          subjectUrl: null,
          reactor,
          reactedAt: n.created_at,
        };
      }
    });

  await redis.set(cacheKey, reactions, { ex: TTL.mastodonReactions }).catch(() => {});
  return reactions;
}

// ── Get user's own platform identity IDs ──────────────────

export async function getOwnIdentityIds(userId: number): Promise<number[]> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const accounts = await db.select().from(connectedAccounts).where(eq(connectedAccounts.userId, userId));

  if (!user || accounts.length === 0) return [];

  const handles = accounts.map((a) => a.handle);
  const rows = await db.select({ id: platformIdentities.id }).from(platformIdentities).where(
    and(
      eq(platformIdentities.userId, userId),
      inArray(platformIdentities.handle, handles)
    )
  );
  return rows.map((r) => r.id);
}

// ── Query posts by identity IDs ────────────────────────────

export async function queryPostsByIdentities(
  identityIds: number[],
  { userId, cursor, limit = 50 }: { userId: number; cursor?: string | null; limit?: number }
): Promise<{ posts: ProfilePost[]; nextCursor: string | null }> {
  if (identityIds.length === 0) return { posts: [], nextCursor: null };

  const conditions = [inArray(posts.platformIdentityId, identityIds)];
  if (cursor) conditions.push(lt(posts.postedAt, new Date(cursor)));

  const identityRows = await db.select().from(platformIdentities)
    .where(inArray(platformIdentities.id, identityIds));
  const identityMap = new Map(identityRows.map((i) => [i.id, i]));

  const fetchLimit = Math.ceil(limit * 1.5);
  const rows = await db.select().from(posts)
    .where(and(...conditions))
    .orderBy(desc(posts.postedAt))
    .limit(fetchLimit);

  // Batch-resolve parent post authors for replies
  const replyToIds = [...new Set(rows.map((p) => p.replyToId).filter(Boolean) as string[])];
  const replyToAuthorMap = new Map<string, { handle: string; dbPostId: number; postUrl: string | null }>();

  if (replyToIds.length > 0) {
    // Look up parent posts we have stored
    const parentRows = await db
      .select({ id: posts.id, platformPostId: posts.platformPostId, postUrl: posts.postUrl, handle: platformIdentities.handle })
      .from(posts)
      .leftJoin(platformIdentities, eq(posts.platformIdentityId, platformIdentities.id))
      .where(and(eq(posts.userId, userId), inArray(posts.platformPostId, replyToIds)));
    for (const r of parentRows) {
      replyToAuthorMap.set(r.platformPostId, { handle: r.handle ?? "", dbPostId: r.id, postUrl: r.postUrl ?? null });
    }

    // For Bluesky URIs not found: extract DID and look up in platformIdentities
    const unresolvedBsky = replyToIds.filter((id) => id.startsWith("at://") && !replyToAuthorMap.has(id));
    if (unresolvedBsky.length > 0) {
      const dids = [...new Set(unresolvedBsky.map((uri) => uri.split("/")[2]).filter(Boolean))];
      const didRows = await db
        .select({ did: platformIdentities.did, handle: platformIdentities.handle })
        .from(platformIdentities)
        .where(and(eq(platformIdentities.userId, userId), inArray(platformIdentities.did, dids)));
      const didToHandle = new Map(didRows.map((r) => [r.did!, r.handle]));
      for (const uri of unresolvedBsky) {
        const did = uri.split("/")[2];
        const rkey = uri.split("/").pop();
        const handle = didToHandle.get(did);
        if (handle) {
          replyToAuthorMap.set(uri, {
            handle,
            dbPostId: 0,
            postUrl: rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null,
          });
        }
      }
    }
  }

  const seen = new Map<string, number>();
  const result: ProfilePost[] = [];

  for (const post of rows) {
    const hash = post.dedupeHash;
    if (hash && seen.has(hash)) {
      const existingIdx = seen.get(hash)!;
      const alreadyListed = result[existingIdx].alsoPostedOn.some((p) => p.platform === post.platform);
      if (!alreadyListed) {
        result[existingIdx].alsoPostedOn.push({
          platform: post.platform,
          postUrl: post.postUrl || null,
          platformPostId: post.platformPostId,
          platformPostCid: post.platformPostCid || null,
          threadRootId: post.threadRootId || null,
          threadRootCid: post.threadRootCid || null,
        });
      }
      continue;
    }

    const identity = identityMap.get(post.platformIdentityId);
    const replyToAuthor = post.replyToId ? (replyToAuthorMap.get(post.replyToId) ?? null) : null;
    const entry: ProfilePost = {
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
      linkCard: typeof post.linkCard === "string" ? JSON.parse(post.linkCard) : (post.linkCard ?? null),
      likeCount: post.likeCount,
      repostCount: post.repostCount,
      replyCount: post.replyCount,
      postedAt: post.postedAt.toISOString(),
      author: identity
        ? { id: identity.id, handle: identity.handle, displayName: identity.displayName, avatarUrl: identity.avatarUrl, platform: identity.platform, profileUrl: identity.profileUrl }
        : null,
      person: null,
      alsoPostedOn: [],
      replyToAuthor,
    };

    if (hash) seen.set(hash, result.length);
    result.push(entry);

    if (result.length === limit) break;
  }

  const nextCursor = result.length === limit ? result[result.length - 1].postedAt : null;
  return { posts: result, nextCursor };
}

export interface ProfilePost {
  id: number;
  platform: string;
  platformPostId: string;
  platformPostCid: string | null;
  postUrl: string | null;
  content: string | null;
  contentHtml: string | null;
  media: unknown;
  replyToId: string | null;
  repostOfId: string | null;
  quotedPost: unknown;
  linkCard: LinkCardData | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: { id: number; handle: string; displayName: string | null; avatarUrl: string | null; platform: string; profileUrl: string | null } | null;
  person: null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null; platformPostId: string; platformPostCid: string | null; threadRootId: string | null; threadRootCid: string | null }>;
  replyToAuthor: { handle: string; dbPostId: number; postUrl: string | null } | null;
}

// ── Query timeline ─────────────────────────────────────────

export interface TimelinePost {
  id: number;
  platform: string;
  platformPostId: string;
  platformPostCid: string | null;
  postUrl: string | null;
  content: string | null;
  contentHtml: string | null;
  media: unknown;
  replyToId: string | null;
  threadRootId: string | null;
  threadRootCid: string | null;
  repostOfId: string | null;
  quotedPost: unknown;
  linkCard: LinkCardData | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: { id: number; handle: string; displayName: string | null; avatarUrl: string | null; platform: string; profileUrl: string | null } | null;
  person: { id: number; displayName: string | null } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null; platformPostId: string; platformPostCid: string | null; threadRootId: string | null; threadRootCid: string | null }>;
  replyToMe?: boolean;
}

export async function queryTimeline(
  userId: number,
  { type, cursor, limit = 50 }: { type?: string | null; cursor?: string | null; limit?: number }
): Promise<{ posts: TimelinePost[]; nextCursor: string | null }> {
  const cacheType = type === "mentions" ? "mentions" : "timeline";

  // Only cache the first page (no cursor)
  if (!cursor) {
    const cacheKey = keys.timelineCache(userId, cacheType);
    const cached = await redis.get<{ posts: TimelinePost[]; nextCursor: string | null }>(cacheKey).catch(() => null);
    if (cached) {
      console.log(`[timeline] cache hit (${cacheType})`);
      return cached;
    }
  }

  const fetchLimit = Math.ceil(limit * 1.5);

  const conditions = [eq(posts.userId, userId)];
  if (type === "mentions") {
    conditions.push(eq(posts.isMention, true));
  } else {
    conditions.push(eq(posts.isTimeline, true));
    conditions.push(isNull(posts.replyToId));
  }
  if (cursor) {
    conditions.push(lt(posts.postedAt, new Date(cursor)));
  }

  const rows = await db
    .select({ post: posts, identity: platformIdentities, person: persons })
    .from(posts)
    .leftJoin(platformIdentities, eq(posts.platformIdentityId, platformIdentities.id))
    .leftJoin(persons, eq(platformIdentities.personId, persons.id))
    .where(and(...conditions))
    .orderBy(desc(posts.postedAt))
    .limit(fetchLimit);

  const seen = new Map<string, number>();
  const result: TimelinePost[] = [];

  for (const row of rows) {
    const hash = row.post.dedupeHash;
    if (hash && seen.has(hash)) {
      const existingIdx = seen.get(hash)!;
      const alreadyListed = result[existingIdx].alsoPostedOn.some(
        (p) => p.platform === row.post.platform
      );
      if (!alreadyListed) {
        result[existingIdx].alsoPostedOn.push({
          platform: row.post.platform,
          postUrl: row.post.postUrl || null,
          platformPostId: row.post.platformPostId,
          platformPostCid: row.post.platformPostCid || null,
          threadRootId: row.post.threadRootId || null,
          threadRootCid: row.post.threadRootCid || null,
        });
      }
      continue;
    }

    const entry: TimelinePost = {
      id: row.post.id,
      platform: row.post.platform,
      platformPostId: row.post.platformPostId,
      platformPostCid: row.post.platformPostCid || null,
      postUrl: row.post.postUrl || null,
      content: row.post.content,
      contentHtml: row.post.contentHtml,
      media: typeof row.post.media === "string" ? JSON.parse(row.post.media) : row.post.media,
      replyToId: row.post.replyToId,
      threadRootId: row.post.threadRootId || null,
      threadRootCid: row.post.threadRootCid || null,
      repostOfId: row.post.repostOfId,
      quotedPost: typeof row.post.quotedPost === "string" ? JSON.parse(row.post.quotedPost) : row.post.quotedPost,
      linkCard: typeof row.post.linkCard === "string" ? JSON.parse(row.post.linkCard) : (row.post.linkCard ?? null),
      likeCount: row.post.likeCount,
      repostCount: row.post.repostCount,
      replyCount: row.post.replyCount,
      postedAt: row.post.postedAt.toISOString(),
      author: row.identity
        ? { id: row.identity.id, handle: row.identity.handle, displayName: row.identity.displayName, avatarUrl: row.identity.avatarUrl, platform: row.identity.platform, profileUrl: row.identity.profileUrl }
        : null,
      person: row.person ? { id: row.person.id, displayName: row.person.displayName } : null,
      alsoPostedOn: [],
      replyToMe: type === "mentions" && !!row.post.replyToId,
    };

    if (hash) seen.set(hash, result.length);
    result.push(entry);
  }

  const trimmed = result.slice(0, limit);
  const nextCursor = trimmed.length === limit ? trimmed[trimmed.length - 1].postedAt : null;
  const response = { posts: trimmed, nextCursor };

  // Cache the first page result
  if (!cursor) {
    const cacheKey = keys.timelineCache(userId, cacheType);
    await redis.set(cacheKey, response, { ex: TTL.timelineCache }).catch(() => {});
  }

  return response;
}

// ── Server-side Bluesky helpers ────────────────────────────

interface BlueskyFacetFeature {
  $type: string;
  uri?: string;
  did?: string;
  tag?: string;
}

interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: BlueskyFacetFeature[];
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkifyUrls(escaped: string): string {
  return escaped.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function facetsToHtml(text: string, facets?: BlueskyFacet[]): string {
  if (!facets || facets.length === 0) {
    return linkifyUrls(escapeHtml(text));
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);
  const sorted = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart);
  let html = "";
  let lastByte = 0;
  for (const facet of sorted) {
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < lastByte || byteEnd > bytes.length) continue;
    html += linkifyUrls(escapeHtml(decoder.decode(bytes.slice(lastByte, byteStart))));
    const facetText = escapeHtml(decoder.decode(bytes.slice(byteStart, byteEnd)));
    const feature = facet.features[0];
    if (feature?.$type === "app.bsky.richtext.facet#link" && feature.uri) {
      html += `<a href="${escapeAttr(feature.uri)}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else if (feature?.$type === "app.bsky.richtext.facet#mention" && feature.did) {
      html += `<a href="https://bsky.app/profile/${escapeAttr(feature.did)}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else if (feature?.$type === "app.bsky.richtext.facet#tag" && feature.tag) {
      html += `<a href="https://bsky.app/hashtag/${escapeAttr(feature.tag)}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else {
      html += facetText;
    }
    lastByte = byteEnd;
  }
  html += linkifyUrls(escapeHtml(decoder.decode(bytes.slice(lastByte))));
  return html;
}

interface BlueskyImageView { thumb: string; alt: string; fullsize: string; }

type ExtractedMedia = { type: string; url: string; alt: string; thumbnailUrl?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBlueskyMedia(embed: any): ExtractedMedia[] {
  if (!embed) return [];
  const items: ExtractedMedia[] = [];
  if (embed.images && Array.isArray(embed.images)) {
    for (const img of embed.images as BlueskyImageView[]) {
      items.push({ type: "image", url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }
  if (embed.media?.images && Array.isArray(embed.media.images)) {
    for (const img of embed.media.images as BlueskyImageView[]) {
      items.push({ type: "image", url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }
  if (embed.playlist) {
    items.push({ type: "video", url: embed.playlist, alt: embed.alt || "", thumbnailUrl: embed.thumbnail || undefined });
  }
  if (embed.media?.playlist) {
    items.push({ type: "video", url: embed.media.playlist, alt: embed.media.alt || "", thumbnailUrl: embed.media.thumbnail || undefined });
  }
  return items;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractQuotedPost(embed: any): QuotedPostData | undefined {
  if (!embed) return undefined;
  const record = embed.record?.record ?? embed.record;
  if (!record?.author || !record?.value) return undefined;
  if (record.$type && !record.$type.includes("viewRecord")) return undefined;
  const quoted: QuotedPostData = {
    uri: record.uri,
    authorHandle: record.author.handle,
    authorDisplayName: record.author.displayName || undefined,
    authorAvatar: record.author.avatar || undefined,
    text: (record.value as { text?: string })?.text || "",
    postedAt: record.indexedAt || (record.value as { createdAt?: string })?.createdAt,
  };
  if (record.embeds && Array.isArray(record.embeds) && record.embeds.length > 0) {
    const embeddedMedia = extractBlueskyMedia(record.embeds[0]);
    if (embeddedMedia.length > 0) {
      quoted.media = embeddedMedia;
    }
  }
  return quoted;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLinkCard(embed: any): LinkCardData | undefined {
  if (!embed) return undefined;
  const ext = embed.external ?? embed.media?.external;
  if (!ext?.uri) return undefined;
  return {
    url: ext.uri,
    title: ext.title || ext.uri,
    description: ext.description || undefined,
    thumb: ext.thumb || undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapBlueskyFeedItem(item: { post: Record<string, unknown>; reason?: unknown }, isMention = false): BlueskyPostData {
  const post = item.post as {
    uri: string;
    cid: string;
    author: { did: string; handle: string; avatar?: string; displayName?: string };
    record: { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string }; root?: { uri?: string; cid?: string } } };
    indexedAt: string;
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
    embed?: unknown;
  };
  const text = post.record?.text || "";
  return {
    uri: post.uri,
    cid: post.cid,
    authorDid: post.author.did,
    authorHandle: post.author.handle,
    authorDisplayName: post.author.displayName || undefined,
    authorAvatar: post.author.avatar || undefined,
    text,
    contentHtml: facetsToHtml(text, post.record?.facets),
    createdAt: post.indexedAt,
    likeCount: post.likeCount,
    repostCount: post.repostCount,
    replyCount: post.replyCount,
    replyToUri: post.record?.reply?.parent?.uri || undefined,
    threadRootUri: post.record?.reply?.root?.uri || undefined,
    threadRootCid: post.record?.reply?.root?.cid || undefined,
    repostOfUri: item.reason ? post.uri : undefined,
    media: extractBlueskyMedia(post.embed),
    quotedPost: extractQuotedPost(post.embed),
    linkCard: extractLinkCard(post.embed),
    isMention,
  };
}

// ── Server-side Bluesky fetch & store ─────────────────────

export async function fetchAndStoreBlueskyPosts(userId: number): Promise<{ stored: number }> {
  const debounceKey = keys.blueskyFetched(userId, "timeline");
  const recentlyFetched = await redis.get(debounceKey).catch(() => null);
  if (recentlyFetched) {
    console.log("[bluesky] timeline fetch skipped (debounced)");
    return { stored: 0 };
  }

  const agent = await getServerBlueskyAgent(userId);
  if (!agent) {
    console.warn("[bluesky] no server agent for user", userId);
    return { stored: 0 };
  }

  const response = await agent.getTimeline({ limit: 50 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blueskyPosts = response.data.feed.map((item) => mapBlueskyFeedItem(item as any));

  const result = await storeBlueskyPosts(blueskyPosts, userId);
  await redis.set(debounceKey, "1", { ex: TTL.blueskyFetchDebounce }).catch(() => {});
  return result;
}

export async function fetchAndStoreBlueskyMentions(userId: number): Promise<{ stored: number }> {
  const debounceKey = keys.blueskyFetched(userId, "mentions");
  const recentlyFetched = await redis.get(debounceKey).catch(() => null);
  if (recentlyFetched) {
    console.log("[bluesky] mentions fetch skipped (debounced)");
    return { stored: 0 };
  }

  const agent = await getServerBlueskyAgent(userId);
  if (!agent) {
    console.warn("[bluesky] no server agent for user", userId);
    return { stored: 0 };
  }

  const response = await agent.listNotifications({ limit: 50 });
  const notifications = response.data.notifications as Array<{
    reason: string;
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string; avatar?: string };
    record: unknown;
    indexedAt: string;
  }>;

  const mentionNotifs = notifications.filter(
    (n) => n.reason === "mention" || n.reason === "reply"
  );

  // Hydrate with embed data via getPosts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hydratedMap = new Map<string, { embed?: unknown; authorDisplayName?: string; authorAvatar?: string }>();
  const mentionUris = mentionNotifs.map((n) => n.uri);
  if (mentionUris.length > 0) {
    try {
      const postsRes = await agent.getPosts({ uris: mentionUris });
      for (const p of postsRes.data.posts) {
        const hp = p as unknown as { embed?: unknown; author: { displayName?: string; avatar?: string } };
        hydratedMap.set(p.uri, {
          embed: hp.embed,
          authorDisplayName: hp.author.displayName || undefined,
          authorAvatar: hp.author.avatar || undefined,
        });
      }
    } catch (err) {
      console.warn("[bluesky] Failed to hydrate mention embeds:", err);
    }
  }

  const blueskyMentionPosts: BlueskyPostData[] = mentionNotifs.map((n) => {
    const record = n.record as { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string } } };
    const text = record?.text || "";
    const hydrated = hydratedMap.get(n.uri);
    return {
      uri: n.uri,
      cid: n.cid,
      authorDid: n.author.did,
      authorHandle: n.author.handle,
      authorDisplayName: hydrated?.authorDisplayName,
      authorAvatar: hydrated?.authorAvatar,
      text,
      contentHtml: facetsToHtml(text, record?.facets),
      createdAt: n.indexedAt,
      replyToUri: record?.reply?.parent?.uri || undefined,
      isMention: true,
      media: extractBlueskyMedia(hydrated?.embed),
      quotedPost: extractQuotedPost(hydrated?.embed),
    };
  });

  const result = await storeBlueskyPosts(blueskyMentionPosts, userId);
  await redis.set(debounceKey, "1", { ex: TTL.blueskyFetchDebounce }).catch(() => {});
  return result;
}

export async function fetchBlueskyReactions(userId: number): Promise<RawReaction[]> {
  const cacheKey = keys.blueskyReactions(userId);
  const cached = await redis.get<RawReaction[]>(cacheKey).catch(() => null);
  if (cached) {
    console.log("[bluesky] reactions cache hit");
    return cached;
  }

  const agent = await getServerBlueskyAgent(userId);
  if (!agent) return [];

  const response = await agent.listNotifications({ limit: 50 });
  const notifications = response.data.notifications as Array<{
    reason: string;
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string; avatar?: string };
    record: unknown;
    indexedAt: string;
    reasonSubject?: string;
  }>;

  const reactionNotifs = notifications.filter(
    (n) => n.reason === "like" || n.reason === "repost" || n.reason === "follow" || n.reason === "quote"
  );

  // Batch-fetch subject post text
  const subjectUris = [
    ...new Set(reactionNotifs.filter((n) => n.reasonSubject).map((n) => n.reasonSubject!)),
  ].slice(0, 25);

  const subjectTextMap = new Map<string, string>();
  const subjectMetaMap = new Map<string, { handle: string; displayName?: string; avatar?: string; postedAt?: string }>();
  if (subjectUris.length > 0) {
    try {
      const subjectsRes = await agent.getPosts({ uris: subjectUris });
      for (const p of subjectsRes.data.posts) {
        const record = (p as unknown as { record: { text?: string } }).record;
        const author = (p as unknown as { author: { handle: string; displayName?: string; avatar?: string } }).author;
        const indexedAt = (p as unknown as { indexedAt?: string }).indexedAt;
        subjectTextMap.set(p.uri, record?.text || "");
        subjectMetaMap.set(p.uri, { handle: author?.handle || "", displayName: author?.displayName, avatar: author?.avatar, postedAt: indexedAt });
      }
    } catch (err) {
      console.warn("[bluesky] Failed to fetch reaction subject posts:", err);
    }
  }

  // Look up internal post IDs for subject URIs
  const subjectInternalIdMap = new Map<string, number>();
  if (subjectUris.length > 0) {
    const rows = await db
      .select({ id: posts.id, platformPostId: posts.platformPostId })
      .from(posts)
      .where(and(eq(posts.userId, userId), inArray(posts.platformPostId, subjectUris)));
    for (const row of rows) {
      subjectInternalIdMap.set(row.platformPostId, row.id);
    }
  }

  // Batch-lookup in-app platform identities for reactors so the UI can link to /persons or /identities.
  const reactorDids = [...new Set(reactionNotifs.map((n) => n.author.did).filter(Boolean))];
  const reactorIdentityByDid = new Map<string, { id: number; personId: number | null }>();
  if (reactorDids.length > 0) {
    const rows = await db
      .select({ id: platformIdentities.id, did: platformIdentities.did, personId: platformIdentities.personId })
      .from(platformIdentities)
      .where(and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "bluesky"),
        inArray(platformIdentities.did, reactorDids)
      ));
    for (const row of rows) {
      if (row.did) reactorIdentityByDid.set(row.did, { id: row.id, personId: row.personId });
    }
  }

  const reactions: RawReaction[] = reactionNotifs.map((n) => {
    const reactionType =
      n.reason === "like" ? "like" as const :
      n.reason === "repost" ? "repost" as const :
      n.reason === "follow" ? "follow" as const :
      "quote" as const;

    const subjectId = n.reasonSubject ?? null;
    const subjectText = subjectId ? (subjectTextMap.get(subjectId) ?? null) : null;
    const internalId = subjectId ? subjectInternalIdMap.get(subjectId) : undefined;
    const subjectUrl = internalId ? `/posts/${internalId}` : null;
    const identity = reactorIdentityByDid.get(n.author.did);

    return {
      platform: "bluesky" as const,
      reactionType,
      subjectId,
      subjectExcerpt: subjectText,
      subjectUrl,
      reactor: {
        handle: n.author.handle,
        did: n.author.did,
        displayName: n.author.displayName || n.author.handle,
        avatarUrl: n.author.avatar || "",
        platformIdentityId: identity?.id ?? null,
        personId: identity?.personId ?? null,
      },
      reactedAt: n.indexedAt,
    };
  });

  await redis.set(cacheKey, reactions, { ex: TTL.blueskyReactions }).catch(() => {});
  return reactions;
}
