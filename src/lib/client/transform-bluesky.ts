// Pure Bluesky transforms, ported from src/lib/posts.ts (facetsToHtml, media /
// quote / link-card extraction, feed mapping). Browser-safe — TextEncoder /
// TextDecoder only, no Node crypto. Maps a hydrated Bluesky feed item straight
// to ClientPost (the server went via an intermediate BlueskyPostData + DB row).

import type { ClientPost, MediaItem, QuotedPost, LinkCard } from "./types";

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
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
}

export function facetsToHtml(text: string, facets?: BlueskyFacet[]): string {
  if (!facets || facets.length === 0) return linkifyUrls(escapeHtml(text));
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBlueskyMedia(embed: any): MediaItem[] {
  if (!embed) return [];
  const items: MediaItem[] = [];
  if (Array.isArray(embed.images)) {
    for (const img of embed.images as BlueskyImageView[]) {
      items.push({ type: "image", url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }
  if (Array.isArray(embed.media?.images)) {
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
function extractQuotedPost(embed: any): QuotedPost | undefined {
  if (!embed) return undefined;
  const record = embed.record?.record ?? embed.record;
  if (!record?.author || !record?.value) return undefined;
  if (record.$type && !record.$type.includes("viewRecord")) return undefined;
  const rkey = typeof record.uri === "string" ? record.uri.split("/").pop() : null;
  const quoted: QuotedPost = {
    uri: record.uri,
    platform: "bluesky",
    postUrl: rkey ? `https://bsky.app/profile/${record.author.handle}/post/${rkey}` : null,
    authorHandle: record.author.handle,
    authorDisplayName: record.author.displayName || undefined,
    authorAvatar: record.author.avatar || undefined,
    text: (record.value as { text?: string })?.text || "",
    postedAt: record.indexedAt || (record.value as { createdAt?: string })?.createdAt,
  };
  if (Array.isArray(record.embeds) && record.embeds.length > 0) {
    const embeddedMedia = extractBlueskyMedia(record.embeds[0]);
    if (embeddedMedia.length > 0) quoted.media = embeddedMedia;
  }
  return quoted;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLinkCard(embed: any): LinkCard | undefined {
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

interface BlueskyFeedItem {
  post: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; avatar?: string; displayName?: string };
    record: { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string }; root?: { uri?: string; cid?: string } } };
    indexedAt: string;
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
    embed?: unknown;
    viewer?: { like?: string; repost?: string };
  };
  reason?: unknown;
}

// Maps a hydrated Bluesky feed item (getTimeline / getAuthorFeed item) to a
// ClientPost. `dedupeHash` is filled in afterwards by the async dedup pass.
export function mapBlueskyFeedItem(item: BlueskyFeedItem): ClientPost {
  const post = item.post;
  const text = post.record?.text || "";
  const rkey = post.uri.split("/").pop();
  const handle = post.author.handle;
  return {
    id: 0,
    platform: "bluesky",
    platformPostId: post.uri,
    platformPostCid: post.cid || null,
    postUrl: rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null,
    content: text,
    contentHtml: facetsToHtml(text, post.record?.facets),
    media: extractBlueskyMedia(post.embed).length > 0 ? extractBlueskyMedia(post.embed) : null,
    replyToId: post.record?.reply?.parent?.uri || null,
    threadRootId: post.record?.reply?.root?.uri || null,
    threadRootCid: post.record?.reply?.root?.cid || null,
    repostOfId: item.reason ? post.uri : null,
    quotedPost: extractQuotedPost(post.embed) || null,
    linkCard: extractLinkCard(post.embed) || null,
    likeCount: post.likeCount ?? 0,
    repostCount: post.repostCount ?? 0,
    replyCount: post.replyCount ?? 0,
    viewerLiked: !!post.viewer?.like,
    viewerReposted: !!post.viewer?.repost,
    postedAt: new Date(post.indexedAt).toISOString(),
    author: {
      id: 0,
      handle,
      displayName: post.author.displayName || null,
      avatarUrl: post.author.avatar || null,
      platform: "bluesky",
      profileUrl: `https://bsky.app/profile/${handle}`,
    },
    person: null,
    alsoPostedOn: [],
    dedupeHash: null,
  };
}
