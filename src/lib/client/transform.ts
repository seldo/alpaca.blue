// Pure transforms from platform API shapes into ClientPost. Ported from the
// server's src/lib/posts.ts so it can run in the browser (no db/redis imports).
// These functions are deliberately dependency-free; later phases will make this
// the single source of truth shared by any remaining server code.

import type { ClientPost, MediaItem, QuotedPost } from "./types";

// ── Mastodon API shapes (subset we consume) ────────────────

export interface MastodonStatus {
  id: string;
  url: string;
  content: string;
  created_at: string;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited?: boolean;
  reblogged?: boolean;
  in_reply_to_id: string | null;
  reblog: MastodonStatus | null;
  quote?: {
    state: "accepted" | "pending" | "rejected" | "revoked" | "deleted" | "unauthorized";
    quoted_status: MastodonStatus | null;
  } | null;
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

// ── HTML → plain text (for dedup hashing / linkify fallback) ─

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Qualifies a bare Mastodon acct (local user) into a full @user@instance handle.
function handleOf(acct: string, instanceHost: string): string {
  return acct.includes("@") ? `@${acct}` : `@${acct}@${instanceHost}`;
}

function mapMedia(
  attachments: MastodonStatus["media_attachments"],
): MediaItem[] {
  return attachments.map((m) => ({
    type: m.type,
    url: m.url,
    alt: m.description || "",
    thumbnailUrl: m.preview_url || undefined,
  }));
}

// Builds a QuotedPost for a native Mastodon 4.4+ quote, when accepted+included.
function extractMastodonQuote(
  status: MastodonStatus,
  instanceHost: string,
): QuotedPost | undefined {
  const q = status.quote;
  if (!q || q.state !== "accepted" || !q.quoted_status) return undefined;
  const qs = q.quoted_status;
  return {
    uri: qs.url || qs.id,
    platform: "mastodon",
    postUrl: qs.url || null,
    authorHandle: handleOf(qs.account.acct, instanceHost),
    authorDisplayName: qs.account.display_name || undefined,
    authorAvatar: qs.account.avatar || undefined,
    text: stripHtmlTags(qs.content),
    contentHtml: qs.content,
    media: mapMedia(qs.media_attachments),
    postedAt: qs.created_at,
  };
}

// Maps a Mastodon home-timeline status into a ClientPost. `instanceHost` is the
// viewer's instance, used to qualify bare local handles. `dedupeHash` is filled
// in by the dedup pass afterwards (it's async, so not computed here).
export function mapMastodonStatus(
  status: MastodonStatus,
  instanceHost: string,
): ClientPost {
  const actual = status.reblog || status;
  const handle = handleOf(actual.account.acct, instanceHost);
  const plainContent = stripHtmlTags(actual.content);
  const media = mapMedia(actual.media_attachments);

  return {
    id: 0,
    platform: "mastodon",
    platformPostId: actual.id,
    platformPostCid: null,
    postUrl: actual.url || null,
    content: plainContent,
    contentHtml: actual.content,
    media: media.length > 0 ? media : null,
    replyToId: actual.in_reply_to_id || null,
    threadRootId: null,
    threadRootCid: null,
    repostOfId: status.reblog ? status.id : null,
    quotedPost: extractMastodonQuote(actual, instanceHost) || null,
    linkCard: null,
    likeCount: actual.favourites_count || 0,
    repostCount: actual.reblogs_count || 0,
    replyCount: actual.replies_count || 0,
    viewerLiked: !!actual.favourited,
    viewerReposted: !!actual.reblogged,
    postedAt: new Date(actual.created_at).toISOString(),
    author: {
      id: 0,
      handle,
      displayName: actual.account.display_name || null,
      avatarUrl: actual.account.avatar || null,
      platform: "mastodon",
      profileUrl: actual.account.url || null,
    },
    person: null,
    alsoPostedOn: [],
    dedupeHash: null,
  };
}
