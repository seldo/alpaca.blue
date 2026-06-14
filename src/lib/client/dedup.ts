// Client-side dedup + cross-post merge. Ported from src/lib/posts.ts. The hash
// uses WebCrypto (crypto.subtle) instead of Node's crypto, but produces the
// identical value (SHA-256 hex, first 16 chars) so client and server agree.

import type { ClientPost, CrossPost } from "./types";

// Content shorter than this (after normalization) is too generic to dedupe
// across different authors — e.g. "lol", "+1". Such posts still get a hash but
// only merge when posted by the same author.
export const DEDUP_SHORT_THRESHOLD = 20;

function normalizeForDedup(content: string): string {
  return content
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b[\w-]+\.[\w-]+\.\w{2,}\/\S*/g, "")
    .replace(/\b[\w-]+\.\w{2,}\/\S*/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export async function computeDedupeHash(content: string): Promise<string | null> {
  const normalized = normalizeForDedup(content);
  if (normalized.length === 0) return null;
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

export function isShortDedupContent(content: string): boolean {
  return normalizeForDedup(content).length < DEDUP_SHORT_THRESHOLD;
}

// Computes + assigns dedupe hashes for a batch of freshly-mapped posts (async,
// WebCrypto). Mutates in place and returns the same array so callers can chain
// into the store + merge. Shared by the Mastodon and Bluesky fetchers.
export async function attachDedupeHashes(posts: ClientPost[]): Promise<ClientPost[]> {
  await Promise.all(
    posts.map(async (p) => {
      p.dedupeHash = await computeDedupeHash(p.content || "");
    }),
  );
  return posts;
}

// Identifies the author of a post for short-content dedup. Resolved persons
// collapse across platforms via personId; everyone else gets a per-handle key
// that can't match across platforms. (The current user's own accounts collapse
// once person enrichment lands; for now they key by handle like anyone else.)
function authorKeyFor(post: ClientPost): string {
  if (post.person?.id) return `p:${post.person.id}`;
  return `h:${post.author?.handle ?? "?"}`;
}

function dedupSeenKey(hash: string, content: string | null, post: ClientPost): string {
  return isShortDedupContent(content ?? "") ? `${hash}|${authorKeyFor(post)}` : hash;
}

function crossPostOf(post: ClientPost): CrossPost {
  return {
    platform: post.platform,
    postUrl: post.postUrl,
    platformPostId: post.platformPostId,
    platformPostCid: post.platformPostCid,
    threadRootId: post.threadRootId,
    threadRootCid: post.threadRootCid,
  };
}

// Collapses cross-posted content into a single entry carrying `alsoPostedOn`.
// `posts` must be pre-sorted newest-first. Mirrors queryTimeline's merge: long
// posts merge on hash alone; short posts only merge within the same author.
// When a pair collides, the side with a native quoted post wins so the renderer
// can show the inline quote card instead of a bare URL.
export function mergeTimeline(posts: ClientPost[]): ClientPost[] {
  const seen = new Map<string, number>();
  const result: ClientPost[] = [];

  for (const post of posts) {
    const hash = post.dedupeHash;
    const seenKey = hash ? dedupSeenKey(hash, post.content, post) : null;

    if (seenKey && seen.has(seenKey)) {
      const idx = seen.get(seenKey)!;
      const existing = result[idx];

      const newHasQuote = !!post.quotedPost;
      const existingHasQuote = !!existing.quotedPost;

      if (newHasQuote && !existingHasQuote) {
        // Promote the quote-carrying side to primary; demote the old one.
        post.alsoPostedOn = [crossPostOf(existing), ...existing.alsoPostedOn];
        result[idx] = post;
      } else if (!existing.alsoPostedOn.some((p) => p.platform === post.platform)) {
        existing.alsoPostedOn.push(crossPostOf(post));
      }
      continue;
    }

    if (seenKey) seen.set(seenKey, result.length);
    result.push(post);
  }

  return result;
}
