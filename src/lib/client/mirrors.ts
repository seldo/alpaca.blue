// Cross-platform repost reconciliation, stateless. A post whose content is
// *only* a URL to a post on the OTHER platform is treated as a cross-post (the
// pattern alpaca — and other tools — produce when amplifying a single-platform
// post). We resolve the linked post and render the bare-URL post as a quote of
// it (see PostCard). No tracking table; works for anyone's posts.

import type { ClientPost, QuotedPost } from "./types";
import { mapMastodonStatus } from "./transform";
import { sharedBluesky, sharedMastodon } from "./clients";
import { searchMastodonStatus } from "./mastodon";

// Classifies a URL as a Bluesky / Mastodon post permalink, or null.
function classifyPostUrl(url: string): "bluesky" | "mastodon" | null {
  try {
    const u = new URL(url);
    if (u.hostname === "bsky.app" && /^\/profile\/[^/]+\/post\/[^/]+$/.test(u.pathname)) {
      return "bluesky";
    }
    // Mastodon status permalinks: /@user/<digits> or /users/<user>/statuses/<digits>
    if (/^\/@[^/]+\/\d+$/.test(u.pathname) || /^\/users\/[^/]+\/statuses\/\d+$/.test(u.pathname)) {
      return "mastodon";
    }
    return null;
  } catch {
    return null;
  }
}

// Returns the cross-post target if `post` is a bare link to a post on the other
// platform (content is nothing but that one URL). Null otherwise.
export function detectMirror(
  post: ClientPost,
): { targetPlatform: "bluesky" | "mastodon"; url: string } | null {
  if (post.quotedPost) return null; // already an embed
  const text = (post.content || "").trim();
  if (!text) return null;
  const urls = text.match(/https?:\/\/\S+/g);
  if (!urls || urls.length !== 1) return null;
  const url = urls[0].replace(/[).,!?]+$/, ""); // strip trailing punctuation
  if (text.replace(urls[0], "").trim() !== "") return null; // any other text → not a bare mirror
  const target = classifyPostUrl(url);
  if (!target || target === post.platform) return null; // must point to the OTHER platform
  return { targetPlatform: target, url };
}

function toQuoted(cp: ClientPost): QuotedPost {
  return {
    uri: cp.platformPostId,
    platform: cp.platform,
    postUrl: cp.postUrl,
    authorHandle: cp.author?.handle ?? "",
    authorDisplayName: cp.author?.displayName ?? undefined,
    authorAvatar: cp.author?.avatarUrl ?? undefined,
    text: cp.content ?? "",
    contentHtml: cp.contentHtml ?? undefined,
    media: cp.media ?? undefined,
    postedAt: cp.postedAt,
  };
}

async function resolveBluesky(url: string): Promise<QuotedPost | null> {
  const m = url.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (!m) return null;
  const bsky = await sharedBluesky();
  if (!bsky) return null;
  const [, actor, rkey] = m;
  const did = actor.startsWith("did:") ? actor : await bsky.resolveHandle(actor).catch(() => null);
  if (!did) return null;
  const cp = await bsky.getPost(`at://${did}/app.bsky.feed.post/${rkey}`);
  return cp ? toQuoted(cp) : null;
}

async function resolveMastodon(url: string): Promise<QuotedPost | null> {
  const creds = await sharedMastodon();
  if (!creds) return null;
  const status = await searchMastodonStatus(creds, url);
  if (!status) return null;
  return toQuoted(mapMastodonStatus(status, new URL(creds.instanceUrl).hostname));
}

// Session cache: url → resolved quote (or null when unresolvable).
const cache = new Map<string, QuotedPost | null>();

// Resolves the quoted post for a detected mirror, or null. Cached by target URL.
export async function resolveMirrorQuote(post: ClientPost): Promise<QuotedPost | null> {
  const m = detectMirror(post);
  if (!m) return null;
  if (cache.has(m.url)) return cache.get(m.url) ?? null;
  let quote: QuotedPost | null = null;
  try {
    quote = m.targetPlatform === "bluesky" ? await resolveBluesky(m.url) : await resolveMastodon(m.url);
  } catch (err) {
    console.error("[mirror] resolve failed:", err);
  }
  cache.set(m.url, quote);
  return quote;
}
