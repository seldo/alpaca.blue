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

// ── Types ──────────────────────────────────────────────────

export interface QuotedPostData {
  uri: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  text: string;
  media?: Array<{ type: string; url: string; alt: string }>;
  postedAt?: string;
}

export interface BlueskyPostData {
  uri: string;
  cid?: string;
  authorDid: string;
  authorHandle: string;
  text: string;
  contentHtml?: string;
  createdAt: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  replyToUri?: string;
  repostOfUri?: string;
  repostedByHandle?: string;
  images?: Array<{ url: string; alt: string }>;
  quotedPost?: QuotedPostData;
  postType?: string; // "timeline" | "mention"
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

  // Insert missing identities only for mentions (rare — people who @-ed us but aren't followed)
  const missingMentions = postsData.filter(
    (p) => p.postType === "mention" && !identityMap.has(p.authorDid)
  );
  for (const post of missingMentions) {
    const [result] = await db.insert(platformIdentities).values({
      userId,
      platform: "bluesky",
      handle: post.authorHandle,
      did: post.authorDid,
      profileUrl: `https://bsky.app/profile/${post.authorHandle}`,
      isFollowed: false,
    }).onDuplicateKeyUpdate({ set: { handle: post.authorHandle } });
    identityMap.set(post.authorDid, { id: result.insertId } as typeof identityRows[0]);
  }

  // Build all post rows in memory
  const rows = [];
  for (const post of postsData) {
    const identity = identityMap.get(post.authorDid);
    if (!identity) continue; // Skip timeline posts from unknown authors

    const media = post.images?.map((img) => ({ type: "image", url: img.url, alt: img.alt }));
    rows.push({
      userId,
      postType: (post.postType || "timeline") as "timeline" | "mention",
      platformIdentityId: identity.id,
      platform: "bluesky" as const,
      platformPostId: post.uri,
      platformPostCid: post.cid || null,
      content: post.text || "",
      contentHtml: post.contentHtml || null,
      media: media && media.length > 0 ? media : null,
      replyToId: post.replyToUri || null,
      repostOfId: post.repostOfUri || null,
      quotedPost: post.quotedPost || null,
      likeCount: post.likeCount || 0,
      repostCount: post.repostCount || 0,
      replyCount: post.replyCount || 0,
      postedAt: new Date(post.createdAt),
      dedupeHash: computeDedupeHash(post.text || ""),
    });
  }

  // Single batch upsert
  if (rows.length > 0) {
    await db.insert(posts).values(rows).onDuplicateKeyUpdate({
      set: {
        content: sql`values(${posts.content})`,
        contentHtml: sql`values(${posts.contentHtml})`,
        platformPostCid: sql`values(${posts.platformPostCid})`,
        media: sql`values(${posts.media})`,
        quotedPost: sql`values(${posts.quotedPost})`,
        likeCount: sql`values(${posts.likeCount})`,
        repostCount: sql`values(${posts.repostCount})`,
        replyCount: sql`values(${posts.replyCount})`,
        fetchedAt: new Date(),
      },
    });
  }

  console.log(`[bluesky] DB ops (${postsData.length} posts, ${rows.length} rows): ${Date.now() - t0}ms`);
  return { stored: rows.length };
}

// ── Fetch & store Mastodon posts ───────────────────────────

export async function fetchAndStoreMastodonPosts(
  userId: number
): Promise<{ stored: number }> {
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
    }));

    rows.push({
      userId,
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
    // Insert individually to get back insertIds (batch insert doesn't return per-row IDs)
    for (const row of newIdentityRows) {
      const [result] = await db.insert(platformIdentities).values(row)
        .onDuplicateKeyUpdate({ set: { did: row.did, displayName: row.displayName, avatarUrl: row.avatarUrl } });
      identityMap.set(row.handle, { id: result.insertId } as typeof identityRows[0]);
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
      postType: "mention" as const,
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
    const media = actual.media_attachments.map((m) => ({ type: m.type, url: m.url, alt: m.description || "" }));
    return {
      userId,
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

  const rows = await db.select().from(posts)
    .where(and(...conditions))
    .orderBy(desc(posts.postedAt))
    .limit(limit);

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

  const result: ProfilePost[] = rows.map((post) => {
    const identity = identityMap.get(post.platformIdentityId);
    const replyToAuthor = post.replyToId ? (replyToAuthorMap.get(post.replyToId) ?? null) : null;
    return {
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
  });

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
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: { id: number; handle: string; displayName: string | null; avatarUrl: string | null; platform: string; profileUrl: string | null } | null;
  person: null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
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
  repostOfId: string | null;
  quotedPost: unknown;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: { id: number; handle: string; displayName: string | null; avatarUrl: string | null; platform: string; profileUrl: string | null } | null;
  person: { id: number; displayName: string | null } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
  replyToMe?: boolean;
}

export async function queryTimeline(
  userId: number,
  { type, cursor, limit = 50 }: { type?: string | null; cursor?: string | null; limit?: number }
): Promise<{ posts: TimelinePost[]; nextCursor: string | null }> {
  const fetchLimit = Math.ceil(limit * 1.5);

  const conditions = [eq(posts.userId, userId)];
  if (type === "mentions") {
    conditions.push(eq(posts.postType, "mention"));
  } else {
    conditions.push(eq(posts.postType, "timeline"));
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
        result[existingIdx].alsoPostedOn.push({ platform: row.post.platform, postUrl: row.post.postUrl || null });
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
      repostOfId: row.post.repostOfId,
      quotedPost: typeof row.post.quotedPost === "string" ? JSON.parse(row.post.quotedPost) : row.post.quotedPost,
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
  return { posts: trimmed, nextCursor };
}
