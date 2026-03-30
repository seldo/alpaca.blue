import { db } from "@/db";
import {
  posts,
  platformIdentities,
  connectedAccounts,
  persons,
} from "@/db/schema";
import { eq, and, lt, desc, isNull } from "drizzle-orm";
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
  let stored = 0;

  for (const post of postsData) {
    try {
      // Look up the platform identity for this author, create if missing (for mentions)
      let [identity] = await db
        .select()
        .from(platformIdentities)
        .where(
          and(
            eq(platformIdentities.userId, userId),
            eq(platformIdentities.platform, "bluesky"),
            eq(platformIdentities.did, post.authorDid)
          )
        )
        .limit(1);

      if (!identity) {
        if (post.postType === "mention") {
          // Create identity on the fly for mention authors we don't follow
          const [result] = await db.insert(platformIdentities).values({
            userId,
            platform: "bluesky",
            handle: post.authorHandle,
            did: post.authorDid,
            profileUrl: `https://bsky.app/profile/${post.authorHandle}`,
            isFollowed: false,
          });
          identity = { id: result.insertId } as typeof identity;
        } else {
          continue; // Skip timeline posts from unknown authors
        }
      }

      const postedAt = new Date(post.createdAt);
      const dedupeHash = computeDedupeHash(post.text || "");
      const media = post.images?.map((img) => ({
        type: "image",
        url: img.url,
        alt: img.alt,
      }));

      await db
        .insert(posts)
        .values({
          userId,
          postType: post.postType || "timeline",
          platformIdentityId: identity.id,
          platform: "bluesky",
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
          postedAt,
          dedupeHash,
        })
        .onDuplicateKeyUpdate({
          set: {
            content: post.text || "",
            contentHtml: post.contentHtml || null,
            platformPostCid: post.cid || null,
            quotedPost: post.quotedPost || null,
            likeCount: post.likeCount || 0,
            repostCount: post.repostCount || 0,
            replyCount: post.replyCount || 0,
            fetchedAt: new Date(),
          },
        });

      stored++;
    } catch (err) {
      console.error(`Failed to store Bluesky post ${post.uri}:`, err);
    }
  }

  return { stored };
}

// ── Fetch & store Mastodon posts ───────────────────────────

export async function fetchAndStoreMastodonPosts(
  userId: number
): Promise<{
  stored: number;
}> {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.platform, "mastodon")
      )
    )
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) {
    throw new Error("Not authenticated with Mastodon");
  }

  const instanceUrl = account.instanceUrl;
  const instanceHost = new URL(instanceUrl).hostname;

  // Fetch home timeline
  const t0 = Date.now();
  const response = await fetch(
    `${instanceUrl}/api/v1/timelines/home?limit=40`,
    {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    }
  );
  console.log(`[mastodon] timeline API fetch: ${Date.now() - t0}ms`);

  if (!response.ok) {
    throw new Error(`Mastodon timeline fetch failed: ${response.status}`);
  }

  const statuses: MastodonStatus[] = await response.json();
  let stored = 0;
  const tDb = Date.now();

  for (const status of statuses) {
    try {
      // Use the original status for reblogs
      const actual = status.reblog || status;
      const acct = actual.account.acct;
      const handle = acct.includes("@")
        ? `@${acct}`
        : `@${acct}@${instanceHost}`;

      // Look up the platform identity
      const [identity] = await db
        .select()
        .from(platformIdentities)
        .where(
          and(
            eq(platformIdentities.userId, userId),
            eq(platformIdentities.platform, "mastodon"),
            eq(platformIdentities.handle, handle)
          )
        )
        .limit(1);

      if (!identity) continue;

      const plainContent = stripHtmlTags(actual.content);
      const postedAt = new Date(actual.created_at);
      const dedupeHash = computeDedupeHash(plainContent);
      const media = actual.media_attachments.map((m) => ({
        type: m.type,
        url: m.url,
        alt: m.description || "",
      }));

      await db
        .insert(posts)
        .values({
          userId,
          platformIdentityId: identity.id,
          platform: "mastodon",
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
          postedAt,
          dedupeHash,
        })
        .onDuplicateKeyUpdate({
          set: {
            content: plainContent,
            contentHtml: actual.content,
            postUrl: actual.url || null,
            likeCount: actual.favourites_count || 0,
            repostCount: actual.reblogs_count || 0,
            replyCount: actual.replies_count || 0,
            fetchedAt: new Date(),
          },
        });

      stored++;
    } catch (err) {
      console.error(`Failed to store Mastodon status ${status.id}:`, err);
    }
  }
  console.log(`[mastodon] DB upsert loop (${statuses.length} statuses): ${Date.now() - tDb}ms, stored=${stored}`);

  return { stored };
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
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.platform, "mastodon")
      )
    )
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) {
    throw new Error("Not authenticated with Mastodon");
  }

  const instanceUrl = account.instanceUrl;
  const instanceHost = new URL(instanceUrl).hostname;

  const t0 = Date.now();
  const response = await fetch(
    `${instanceUrl}/api/v1/notifications?types[]=mention&limit=40`,
    {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    }
  );
  console.log(`[mastodon] mentions API fetch: ${Date.now() - t0}ms`);

  if (!response.ok) {
    throw new Error(`Mastodon mentions fetch failed: ${response.status}`);
  }

  const notifications: MastodonNotification[] = await response.json();
  let stored = 0;
  const tDb = Date.now();

  for (const notification of notifications) {
    if (!notification.status) continue;
    const status = notification.status;

    try {
      const acct = status.account.acct;
      const handle = acct.includes("@")
        ? `@${acct}`
        : `@${acct}@${instanceHost}`;

      let [identity] = await db
        .select()
        .from(platformIdentities)
        .where(
          and(
            eq(platformIdentities.userId, userId),
            eq(platformIdentities.platform, "mastodon"),
            eq(platformIdentities.handle, handle)
          )
        )
        .limit(1);

      if (!identity) {
        const [result] = await db.insert(platformIdentities).values({
          userId,
          platform: "mastodon",
          handle,
          did: status.account.id,
          displayName: status.account.display_name || null,
          avatarUrl: status.account.avatar || null,
          profileUrl: status.account.url,
          isFollowed: false,
        });
        identity = { id: result.insertId } as typeof identity;
      }

      const plainContent = stripHtmlTags(status.content);
      const postedAt = new Date(status.created_at);
      const dedupeHash = computeDedupeHash(plainContent);
      const media = status.media_attachments.map((m) => ({
        type: m.type,
        url: m.url,
        alt: m.description || "",
      }));

      await db
        .insert(posts)
        .values({
          userId,
          postType: "mention",
          platformIdentityId: identity.id,
          platform: "mastodon",
          platformPostId: status.id,
          postUrl: status.url || null,
          content: plainContent,
          contentHtml: status.content,
          media: media.length > 0 ? media : null,
          replyToId: status.in_reply_to_id || null,
          likeCount: status.favourites_count || 0,
          repostCount: status.reblogs_count || 0,
          replyCount: status.replies_count || 0,
          postedAt,
          dedupeHash,
        })
        .onDuplicateKeyUpdate({
          set: {
            content: plainContent,
            contentHtml: status.content,
            postUrl: status.url || null,
            likeCount: status.favourites_count || 0,
            repostCount: status.reblogs_count || 0,
            replyCount: status.replies_count || 0,
            fetchedAt: new Date(),
          },
        });

      stored++;
    } catch (err) {
      console.error(`Failed to store Mastodon mention ${notification.id}:`, err);
    }
  }
  console.log(`[mastodon] DB upsert loop (${notifications.length} notifications): ${Date.now() - tDb}ms, stored=${stored}`);

  return { stored };
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
    };

    if (hash) seen.set(hash, result.length);
    result.push(entry);
  }

  const trimmed = result.slice(0, limit);
  const nextCursor = trimmed.length === limit ? trimmed[trimmed.length - 1].postedAt : null;
  return { posts: trimmed, nextCursor };
}
