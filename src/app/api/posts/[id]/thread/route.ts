import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, connectedAccounts } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// ── Types ─────────────────────────────────────────────────────

interface ThreadPost {
  id: number; // 0 = not in our DB
  platform: string;
  platformPostId: string;
  platformPostCid: string | null;
  postUrl: string | null;
  content: string | null;
  contentHtml: string | null;
  media: Array<{ type: string; url: string; alt: string }> | null;
  replyToId: string | null;
  repostOfId: string | null;
  quotedPost: null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: {
    id: number;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    platform: string;
    profileUrl: string | null;
  } | null;
  person: null;
  alsoPostedOn: [];
}

interface BskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string; tag?: string }>;
}

interface BskyPost {
  uri: string;
  cid: string;
  author: { did: string; handle: string; displayName?: string; avatar?: string };
  record: {
    text?: string;
    facets?: BskyFacet[];
    reply?: { parent?: { uri?: string } };
    createdAt?: string;
  };
  embed?: unknown;
  indexedAt: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
}

interface BskyThreadNode {
  $type: string;
  post?: BskyPost;
  parent?: BskyThreadNode;
  replies?: BskyThreadNode[];
}

interface MastodonContextStatus {
  id: string;
  url: string;
  content: string;
  created_at: string;
  account: {
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
    url: string;
  };
  in_reply_to_id: string | null;
  media_attachments: Array<{ type: string; url: string; description: string | null }>;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
}

// ── HTML helpers ────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function linkify(escaped: string): string {
  return escaped.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function bskyFacetsToHtml(text: string, facets?: BskyFacet[]): string {
  if (!facets || facets.length === 0) return linkify(escapeHtml(text));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);
  const sorted = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart);
  let html = "";
  let lastByte = 0;
  for (const facet of sorted) {
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < lastByte || byteEnd > bytes.length) continue;
    html += linkify(escapeHtml(decoder.decode(bytes.slice(lastByte, byteStart))));
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
  html += linkify(escapeHtml(decoder.decode(bytes.slice(lastByte))));
  return html;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

// ── Bluesky image extraction ─────────────────────────────────

function extractBskyImages(embed: unknown): Array<{ type: string; url: string; alt: string }> | null {
  if (!embed || typeof embed !== "object") return null;
  const e = embed as Record<string, unknown>;
  if (e.$type === "app.bsky.embed.images#view" && Array.isArray(e.images)) {
    return (e.images as Array<{ thumb: string; fullsize: string; alt: string }>).map((img) => ({
      type: "image",
      url: img.fullsize || img.thumb,
      alt: img.alt || "",
    }));
  }
  if (e.$type === "app.bsky.embed.recordWithMedia#view" && e.media) {
    return extractBskyImages(e.media);
  }
  return null;
}

// ── Mappers ───────────────────────────────────────────────────

function mapBskyPost(post: BskyPost, dbId: number): ThreadPost {
  const text = post.record?.text || "";
  const rkey = post.uri.split("/").pop();
  const profileUrl = `https://bsky.app/profile/${post.author.handle}`;
  const postUrl = rkey ? `https://bsky.app/profile/${post.author.handle}/post/${rkey}` : null;
  const images = extractBskyImages(post.embed);
  return {
    id: dbId,
    platform: "bluesky",
    platformPostId: post.uri,
    platformPostCid: post.cid || null,
    postUrl,
    content: text,
    contentHtml: bskyFacetsToHtml(text, post.record?.facets),
    media: images,
    replyToId: post.record?.reply?.parent?.uri || null,
    repostOfId: null,
    quotedPost: null,
    likeCount: post.likeCount ?? null,
    repostCount: post.repostCount ?? null,
    replyCount: post.replyCount ?? null,
    postedAt: post.indexedAt || post.record?.createdAt || new Date().toISOString(),
    author: {
      id: 0,
      handle: post.author.handle,
      displayName: post.author.displayName || null,
      avatarUrl: post.author.avatar || null,
      platform: "bluesky",
      profileUrl,
    },
    person: null,
    alsoPostedOn: [],
  };
}

function mapMastodonStatus(status: MastodonContextStatus, instanceHost: string, dbId: number): ThreadPost {
  const handle = status.account.acct.includes("@")
    ? `@${status.account.acct}`
    : `@${status.account.acct}@${instanceHost}`;
  const media = status.media_attachments.map((m) => ({
    type: m.type,
    url: m.url,
    alt: m.description || "",
  }));
  return {
    id: dbId,
    platform: "mastodon",
    platformPostId: status.id,
    platformPostCid: null,
    postUrl: status.url || null,
    content: stripHtml(status.content),
    contentHtml: status.content,
    media: media.length > 0 ? media : null,
    replyToId: status.in_reply_to_id || null,
    repostOfId: null,
    quotedPost: null,
    likeCount: status.favourites_count,
    repostCount: status.reblogs_count,
    replyCount: status.replies_count,
    postedAt: status.created_at,
    author: {
      id: 0,
      handle,
      displayName: status.account.display_name || null,
      avatarUrl: status.account.avatar || null,
      platform: "mastodon",
      profileUrl: status.account.url,
    },
    person: null,
    alsoPostedOn: [],
  };
}

// ── DB ID lookup ──────────────────────────────────────────────

async function lookupDbIds(userId: number, platformPostIds: string[]): Promise<Map<string, number>> {
  if (platformPostIds.length === 0) return new Map();
  const rows = await db
    .select({ id: posts.id, platformPostId: posts.platformPostId })
    .from(posts)
    .where(and(eq(posts.userId, userId), inArray(posts.platformPostId, platformPostIds)));
  return new Map(rows.map((r) => [r.platformPostId, r.id]));
}

// ── Platform handlers ─────────────────────────────────────────

async function fetchBlueskyThread(userId: number, uri: string) {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=6&parentHeight=20`,
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) return NextResponse.json({ ancestors: [], replies: [] });

  const data = await res.json();
  const thread: BskyThreadNode = data.thread;
  if (thread.$type !== "app.bsky.feed.defs#threadViewPost") {
    return NextResponse.json({ ancestors: [], replies: [] });
  }

  // Walk up ancestor chain (result is oldest-first after unshift)
  const ancestorBskyPosts: BskyPost[] = [];
  let cur = thread.parent;
  while (cur && cur.$type === "app.bsky.feed.defs#threadViewPost" && cur.post) {
    ancestorBskyPosts.unshift(cur.post);
    cur = cur.parent;
  }

  // Flatten all descendants (BFS order = chronological)
  const replyBskyPosts: BskyPost[] = [];
  function collectReplies(node: BskyThreadNode) {
    if (node.$type !== "app.bsky.feed.defs#threadViewPost" || !node.post) return;
    replyBskyPosts.push(node.post);
    if (node.replies) {
      for (const child of node.replies) collectReplies(child);
    }
  }
  if (thread.replies) {
    for (const reply of thread.replies) collectReplies(reply);
  }

  const allUris = [...ancestorBskyPosts.map((p) => p.uri), ...replyBskyPosts.map((p) => p.uri)];
  const dbIds = await lookupDbIds(userId, allUris);

  return NextResponse.json({
    ancestors: ancestorBskyPosts.map((p) => mapBskyPost(p, dbIds.get(p.uri) ?? 0)),
    replies: replyBskyPosts.map((p) => mapBskyPost(p, dbIds.get(p.uri) ?? 0)),
  });
}

async function fetchMastodonThread(userId: number, statusId: string) {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) {
    return NextResponse.json({ ancestors: [], replies: [] });
  }

  const instanceHost = new URL(account.instanceUrl).hostname;
  const res = await fetch(
    `${account.instanceUrl}/api/v1/statuses/${statusId}/context`,
    { headers: { Authorization: `Bearer ${account.accessToken}` } }
  );
  if (!res.ok) return NextResponse.json({ ancestors: [], replies: [] });

  const data = await res.json();
  const ancestors: MastodonContextStatus[] = data.ancestors || [];
  const descendants: MastodonContextStatus[] = data.descendants || [];

  const allIds = [...ancestors.map((s) => s.id), ...descendants.map((s) => s.id)];
  const dbIds = await lookupDbIds(userId, allIds);

  return NextResponse.json({
    ancestors: ancestors.map((s) => mapMastodonStatus(s, instanceHost, dbIds.get(s.id) ?? 0)),
    replies: descendants.map((s) => mapMastodonStatus(s, instanceHost, dbIds.get(s.id) ?? 0)),
  });
}

// ── Route handler ─────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { id } = await params;
    const postId = parseInt(id);
    if (isNaN(postId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

    const [row] = await db
      .select({ platform: posts.platform, platformPostId: posts.platformPostId })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.userId, userId)))
      .limit(1);

    if (!row) return NextResponse.json({ error: "Post not found" }, { status: 404 });

    if (row.platform === "bluesky") return fetchBlueskyThread(userId, row.platformPostId);
    if (row.platform === "mastodon") return fetchMastodonThread(userId, row.platformPostId);

    return NextResponse.json({ ancestors: [], replies: [] });
  } catch (err) {
    console.error("Thread fetch error:", err);
    return NextResponse.json({ error: "Failed to fetch thread" }, { status: 500 });
  }
}
