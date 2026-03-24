import { db } from "@/db";
import {
  posts,
  platformIdentities,
  connectedAccounts,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
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
  postedAt: Date
): string | null {
  // Normalize: lowercase, strip URLs (full and bare-domain), collapse whitespace
  const normalized = content
    .toLowerCase()
    // Full URLs
    .replace(/https?:\/\/\S+/g, "")
    // Bare domain URLs (e.g. "example.com/path..." from Bluesky truncation)
    .replace(/\b[\w-]+\.[\w-]+\.\w{2,}\/\S*/g, "")
    .replace(/\b[\w-]+\.\w{2,}\/\S*/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length < 20) return null;

  // 5-minute time window
  const timeWindow = Math.floor(postedAt.getTime() / (5 * 60 * 1000));
  const input = `${normalized}|${timeWindow}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ── Store Bluesky posts ────────────────────────────────────

export async function storeBlueskyPosts(
  postsData: BlueskyPostData[],
  userId: number
): Promise<{ stored: number }> {
  let stored = 0;

  for (const post of postsData) {
    try {
      // Look up the platform identity for this author
      const [identity] = await db
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

      if (!identity) continue; // Skip posts from unknown authors

      const postedAt = new Date(post.createdAt);
      const dedupeHash = computeDedupeHash(post.text || "", postedAt);
      const media = post.images?.map((img) => ({
        type: "image",
        url: img.url,
        alt: img.alt,
      }));

      await db
        .insert(posts)
        .values({
          userId,
          platformIdentityId: identity.id,
          platform: "bluesky",
          platformPostId: post.uri,
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
  const response = await fetch(
    `${instanceUrl}/api/v1/timelines/home?limit=40`,
    {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Mastodon timeline fetch failed: ${response.status}`);
  }

  const statuses: MastodonStatus[] = await response.json();
  let stored = 0;

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
      const dedupeHash = computeDedupeHash(plainContent, postedAt);
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

  return { stored };
}
