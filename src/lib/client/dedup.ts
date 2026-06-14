// Client-side dedup + cross-post merge. Ported from src/lib/posts.ts. The hash
// uses WebCrypto (crypto.subtle) instead of Node's crypto, but produces the
// identical value (SHA-256 hex, first 16 chars) so client and server agree.

import type { ClientPost, CrossPost } from "./types";

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

// Identifies the author for dedup. Resolved persons collapse across platforms
// via personId; everyone else gets a per-handle key that can't match across
// platforms. (The current user's own accounts collapse once person enrichment
// lands; for now they key by handle like anyone else.)
function authorKeyFor(post: ClientPost): string {
  // The viewer's own accounts share one bucket so their cross-posts collapse
  // even before identity resolution links the accounts to a person.
  if (post.author?.isSelf) return "me";
  if (post.person?.id) return `p:${post.person.id}`;
  return `h:${post.author?.handle ?? "?"}`;
}

// Cross-posts only collapse when we're confident it's the same author: the hash
// alone isn't enough, because two different accounts (or a fediverse bridge)
// posting identical text would otherwise be mislabeled as "Also on …". So we
// always gate on the author key — for cross-platform merges that means the two
// identities must be linked to the same resolved person.
function dedupSeenKey(hash: string, post: ClientPost): string {
  return `${hash}|${authorKeyFor(post)}`;
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
// `posts` must be pre-sorted newest-first. Posts merge only when both the
// normalized-text hash and the author key match (see dedupSeenKey). When a pair
// collides, the side with a native quoted post wins so the renderer can show the
// inline quote card instead of a bare URL.
export function mergeTimeline(posts: ClientPost[]): ClientPost[] {
  const seen = new Map<string, number>();
  const result: ClientPost[] = [];

  for (const post of posts) {
    const hash = post.dedupeHash;
    const seenKey = hash ? dedupSeenKey(hash, post) : null;

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
