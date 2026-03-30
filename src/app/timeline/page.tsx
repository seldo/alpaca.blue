"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { useRouter } from "next/navigation";
import {
  getBlueskyAgent,
  setBlueskyAgent,
  restoreBlueskySession,
} from "@/lib/bluesky-oauth";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { CreatePost } from "@/components/CreatePost";

interface PostData {
  id: number;
  platform: string;
  platformPostId: string;
  platformPostCid?: string | null;
  postUrl: string | null;
  content: string | null;
  contentHtml: string | null;
  media: Array<{ type: string; url: string; alt: string }> | null;
  replyToId: string | null;
  repostOfId: string | null;
  quotedPost: {
    uri: string;
    authorHandle: string;
    authorDisplayName?: string;
    authorAvatar?: string;
    text: string;
    media?: Array<{ type: string; url: string; alt: string }>;
    postedAt?: string;
  } | null;
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
  person: {
    id: number;
    displayName: string | null;
  } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
}

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

// Convert Bluesky text + facets into HTML with clickable links, mentions, and hashtags.
// Facets use byte offsets into UTF-8 encoded text.
function facetsToHtml(text: string, facets?: BlueskyFacet[]): string {
  if (!facets || facets.length === 0) {
    return linkifyUrls(escapeHtml(text));
  }

  // Convert string to UTF-8 bytes for correct indexing
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);

  // Sort facets by byte start position
  const sorted = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart);

  let html = "";
  let lastByte = 0;

  for (const facet of sorted) {
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < lastByte || byteEnd > bytes.length) continue;

    // Add text before this facet (linkify any bare URLs in it)
    html += linkifyUrls(escapeHtml(decoder.decode(bytes.slice(lastByte, byteStart))));

    // Get the facet text
    const facetText = escapeHtml(decoder.decode(bytes.slice(byteStart, byteEnd)));

    // Apply the first recognized feature
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

  // Add remaining text after last facet (linkify any bare URLs in it)
  html += linkifyUrls(escapeHtml(decoder.decode(bytes.slice(lastByte))));

  return html;
}

function linkifyUrls(escaped: string): string {
  return escaped.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface BlueskyImage {
  thumb: string;
  alt: string;
  fullsize: string;
}

// Extract images from any Bluesky embed type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBlueskyImages(embed: any): Array<{ url: string; alt: string }> {
  if (!embed) return [];

  const images: Array<{ url: string; alt: string }> = [];

  // app.bsky.embed.images#view — direct image embed
  if (embed.images && Array.isArray(embed.images)) {
    for (const img of embed.images as BlueskyImage[]) {
      images.push({ url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }

  // app.bsky.embed.recordWithMedia#view — quote post with media
  if (embed.media?.images && Array.isArray(embed.media.images)) {
    for (const img of embed.media.images as BlueskyImage[]) {
      images.push({ url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }

  // app.bsky.embed.video#view — video with thumbnail
  if (embed.playlist && embed.thumbnail) {
    images.push({ url: embed.thumbnail, alt: "Video thumbnail" });
  }
  if (embed.media?.playlist && embed.media?.thumbnail) {
    images.push({ url: embed.media.thumbnail, alt: "Video thumbnail" });
  }

  // app.bsky.embed.external#view — link card with thumbnail
  if (embed.external?.thumb) {
    images.push({ url: embed.external.thumb, alt: embed.external.title || "" });
  }

  return images;
}

// Extract quoted post from record embeds
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractQuotedPost(embed: any): {
  uri: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  text: string;
  media?: Array<{ type: string; url: string; alt: string }>;
  postedAt?: string;
} | undefined {
  if (!embed) return undefined;

  // The record lives at embed.record for both record#view and recordWithMedia#view
  const record = embed.record?.record ?? embed.record;

  // Must be a viewRecord with author and value
  if (!record?.author || !record?.value) return undefined;
  // Skip if it's a viewNotFound or viewBlocked
  if (record.$type && !record.$type.includes("viewRecord")) return undefined;

  const quoted: {
    uri: string;
    authorHandle: string;
    authorDisplayName?: string;
    authorAvatar?: string;
    text: string;
    media?: Array<{ type: string; url: string; alt: string }>;
    postedAt?: string;
  } = {
    uri: record.uri,
    authorHandle: record.author.handle,
    authorDisplayName: record.author.displayName || undefined,
    authorAvatar: record.author.avatar || undefined,
    text: (record.value as { text?: string })?.text || "",
    postedAt: record.indexedAt || (record.value as { createdAt?: string })?.createdAt,
  };

  // Check if the quoted post itself has embedded images
  if (record.embeds && Array.isArray(record.embeds) && record.embeds.length > 0) {
    const embeddedImages = extractBlueskyImages(record.embeds[0]);
    if (embeddedImages.length > 0) {
      quoted.media = embeddedImages.map((img) => ({
        type: "image",
        url: img.url,
        alt: img.alt,
      }));
    }
  }

  return quoted;
}

function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Only treat definitive HTTP 401s as auth failures — not transient errors or
  // refresh failures, which might succeed on retry.
  return "status" in err && (err as { status: number }).status === 401;
}

export default function TimelinePage() {
  const router = useRouter();
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);
  const pendingScrollRestore = useRef<number | null>(null);
  const isFetchingRef = useRef(false);

  // Initialize Bluesky agent
  useEffect(() => {
    const existing = getBlueskyAgent();
    if (existing) {
      agentRef.current = existing;
      return;
    }

    (async () => {
      const agent = await restoreBlueskySession();
      if (agent) {
        agentRef.current = agent;
      } else {
        setFetchError("Your Bluesky session has expired. Please log out and log back in to reconnect.");
      }
    })();
  }, []);

  const fetchTimeline = useCallback(
    async (cursor?: string, type?: string) => {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      if (type) params.set("type", type);

      const res = await fetch(`/api/timeline?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      return data;
    },
    []
  );

  // Map a Bluesky post item to our BlueskyPostData shape
  function mapBlueskyPost(
    item: { post: Record<string, unknown>; reason?: unknown },
    postType?: string
  ) {
    const post = item.post as {
      uri: string;
      cid: string;
      author: { did: string; handle: string; avatar?: string; displayName?: string };
      record: { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string } } };
      indexedAt: string;
      likeCount?: number;
      repostCount?: number;
      replyCount?: number;
      embed?: unknown;
    };
    const text = post.record?.text || "";
    const contentHtml = facetsToHtml(text, post.record?.facets);
    return {
      uri: post.uri,
      cid: post.cid,
      authorDid: post.author.did,
      authorHandle: post.author.handle,
      authorDisplayName: post.author.displayName || undefined,
      authorAvatar: post.author.avatar || undefined,
      text,
      contentHtml,
      createdAt: post.indexedAt,
      likeCount: post.likeCount,
      repostCount: post.repostCount,
      replyCount: post.replyCount,
      replyToUri: post.record?.reply?.parent?.uri || undefined,
      repostOfUri: item.reason ? post.uri : undefined,
      images: extractBlueskyImages(post.embed),
      quotedPost: extractQuotedPost(post.embed),
      postType,
    };
  }

  // Fetch posts from both platforms and load the timeline in one request
  const refreshFeed = useCallback(async () => {
    if (isFetchingRef.current) {
      console.log("[timeline] refreshFeed called while already fetching, skipping");
      return;
    }
    isFetchingRef.current = true;
    sessionStorage.removeItem("timeline_cache");
    sessionStorage.removeItem("timeline_scroll");
    setFetching(true);
    setFetchStatus("Fetching posts...");
    setFetchError(null);

    try {
      // Fetch Bluesky client-side (needs DPoP agent), then send both to server in one call
      let blueskyPosts: ReturnType<typeof mapBlueskyPost>[] = [];
      const agent = agentRef.current;
      if (agent?.did) {
        try {
          setFetchStatus("Fetching Bluesky timeline...");
          const response = await agent.getTimeline({ limit: 50 });
          blueskyPosts = response.data.feed.map((item) =>
            mapBlueskyPost(item as unknown as { post: Record<string, unknown>; reason?: unknown })
          );
        } catch (err) {
          console.error("Bluesky fetch error:", err instanceof Error ? err.message : err);
          if (isAuthError(err)) {
            setBlueskyAgent(null);
            agentRef.current = null;
            setFetchError("Your Bluesky session has expired. Please reload the page to reconnect.");
          } else {
            setFetchError("Bluesky fetch failed — check your connection.");
          }
        }
      }

      setFetchStatus("Fetching Mastodon timeline...");
      const res = await fetch("/api/posts/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "all", posts: blueskyPosts }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("Feed fetch error:", data.error);
        if (res.status === 401) {
          setFetchError("Your Mastodon session has expired. Please reconnect your account.");
        }
      } else {
        const data = await res.json();
        setPosts(data.posts);
        setNextCursor(data.nextCursor);
      }
    } catch (err) {
      console.error("Feed fetch error:", err);
    } finally {
      setFetching(false);
      setFetchStatus("");
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refreshFeed, fetching);

  // Save timeline state to sessionStorage whenever posts or cursor change
  useEffect(() => {
    if (posts.length > 0) {
      sessionStorage.setItem(
        "timeline_cache",
        JSON.stringify({ posts, nextCursor })
      );
    }
  }, [posts, nextCursor]);

  // Save scroll position on scroll (debounced)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function handleScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        sessionStorage.setItem("timeline_scroll", String(window.scrollY));
      }, 100);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    const cached = sessionStorage.getItem("timeline_cache");
    if (cached) {
      try {
        const { posts: cachedPosts, nextCursor: cachedCursor } = JSON.parse(cached);
        if (cachedPosts?.length > 0) {
          setPosts(cachedPosts);
          setNextCursor(cachedCursor);
          setLoading(false);
          const savedScroll = sessionStorage.getItem("timeline_scroll");
          if (savedScroll) {
            pendingScrollRestore.current = parseInt(savedScroll);
          }
          return;
        }
      } catch {
        // Invalid cache, fall through to fresh fetch
      }
    }

    const timer = setTimeout(refreshFeed, 500);
    return () => clearTimeout(timer);
  }, [refreshFeed]);

  useEffect(() => {
    if (!loading && posts.length === 0) {
      router.replace("/settings");
    }
  }, [loading, posts.length, router]);

  // Restore scroll position after posts have rendered
  useLayoutEffect(() => {
    if (pendingScrollRestore.current !== null && posts.length > 0) {
      window.scrollTo(0, pendingScrollRestore.current);
      pendingScrollRestore.current = null;
    }
  }, [posts]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchTimeline(nextCursor);
      setPosts((prev) => [...prev, ...data.posts]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Load more error:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppLayout blueskyAgent={agentRef.current}>

      {composeOpen ? (
        <div className="create-post-modal-backdrop" onClick={() => setComposeOpen(false)}>
          <div className="create-post-modal" onClick={(e) => e.stopPropagation()}>
            <p className="create-post-modal-title">New Post</p>
            <CreatePost
              blueskyAgent={agentRef.current}
              onClose={() => setComposeOpen(false)}
              onPosted={() => { setComposeOpen(false); setTimeout(refreshFeed, 1000); }}
            />
          </div>
        </div>
      ) : (
        <button className="create-post-trigger" onClick={() => setComposeOpen(true)}>
          What&apos;s up?
        </button>
      )}

      {(pullDistance > 0 || pullRefreshing) && (
        <div className="pull-indicator" style={{ height: pullRefreshing ? 48 : pullDistance * 0.5 }}>
          <div className="spinner" style={{ opacity: pullRefreshing ? 1 : pullDistance > 0 ? 0.4 + 0.6 * (pullDistance / 72) : 0 }} />
        </div>
      )}

      {fetching && fetchStatus && (
        <p className="text-muted" style={{ textAlign: "center", padding: "4px 0", fontSize: "0.85em" }}>{fetchStatus}</p>
      )}

      {fetchError && (
        <p className="text-muted" style={{ textAlign: "center", padding: "8px 0", color: "var(--color-error, #c0392b)" }}>
          {fetchError}{" "}
          {fetchError.includes("expired") && <button onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}>Log out</button>}
        </p>
      )}

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && (
        <div className="timeline-feed">
          {posts.map((post) => (
            <PostCard key={`${post.platform}-${post.id}`} post={post} blueskyAgent={agentRef.current} />
          ))}

          {nextCursor && (
            <div className="load-more">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="btn btn-outline load-more-btn"
              >
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </AppLayout>
  );
}
