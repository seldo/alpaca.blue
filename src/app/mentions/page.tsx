"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import {
  getBlueskyAgent,
  setBlueskyAgent,
  restoreBlueskySession,
} from "@/lib/bluesky-oauth";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";

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
  replyToMe?: boolean;
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

interface BlueskyImage { thumb: string; alt: string; fullsize: string; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBlueskyImages(embed: any): Array<{ url: string; alt: string }> {
  if (!embed) return [];
  const images: Array<{ url: string; alt: string }> = [];
  if (embed.images && Array.isArray(embed.images)) {
    for (const img of embed.images as BlueskyImage[]) {
      images.push({ url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }
  if (embed.media?.images && Array.isArray(embed.media.images)) {
    for (const img of embed.media.images as BlueskyImage[]) {
      images.push({ url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }
  if (embed.playlist && embed.thumbnail) {
    images.push({ url: embed.thumbnail, alt: "Video thumbnail" });
  }
  if (embed.media?.playlist && embed.media?.thumbnail) {
    images.push({ url: embed.media.thumbnail, alt: "Video thumbnail" });
  }
  if (embed.external?.thumb) {
    images.push({ url: embed.external.thumb, alt: embed.external.title || "" });
  }
  return images;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractQuotedPost(embed: any): {
  uri: string; authorHandle: string; authorDisplayName?: string;
  authorAvatar?: string; text: string;
  media?: Array<{ type: string; url: string; alt: string }>; postedAt?: string;
} | undefined {
  if (!embed) return undefined;
  const record = embed.record?.record ?? embed.record;
  if (!record?.author || !record?.value) return undefined;
  if (record.$type && !record.$type.includes("viewRecord")) return undefined;
  const quoted: { uri: string; authorHandle: string; authorDisplayName?: string; authorAvatar?: string; text: string; media?: Array<{ type: string; url: string; alt: string }>; postedAt?: string; } = {
    uri: record.uri,
    authorHandle: record.author.handle,
    authorDisplayName: record.author.displayName || undefined,
    authorAvatar: record.author.avatar || undefined,
    text: (record.value as { text?: string })?.text || "",
    postedAt: record.indexedAt || (record.value as { createdAt?: string })?.createdAt,
  };
  if (record.embeds && Array.isArray(record.embeds) && record.embeds.length > 0) {
    const embeddedImages = extractBlueskyImages(record.embeds[0]);
    if (embeddedImages.length > 0) {
      quoted.media = embeddedImages.map((img) => ({ type: "image", url: img.url, alt: img.alt }));
    }
  }
  return quoted;
}

function facetsToHtml(text: string, facets?: BlueskyFacet[]): string {
  if (!facets || facets.length === 0) {
    return linkifyUrls(escapeHtml(text));
  }

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

function linkifyUrls(escaped: string): string {
  return escaped.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return "status" in err && (err as { status: number }).status === 401;
}

export default function MentionsPage() {
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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

  const fetchMentions = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams({ limit: "50", type: "mentions" });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`/api/timeline?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      return data;
    },
    []
  );

  const refreshFeed = useCallback(async () => {
    if (isFetchingRef.current) {
      console.log("[mentions] refreshFeed called while already fetching, skipping");
      return;
    }
    isFetchingRef.current = true;
    sessionStorage.removeItem("mentions_cache");
    sessionStorage.removeItem("mentions_scroll");
    setFetching(true);
    setFetchStatus("Fetching mentions...");
    setFetchError(null);

    try {
      // Fetch Bluesky mentions client-side, then send both to server in one call
      let blueskyPosts: {
        uri: string; cid: string; authorDid: string; authorHandle: string;
        text: string; contentHtml: string; createdAt: string;
        replyToUri?: string; postType: string;
        images?: Array<{ url: string; alt: string }>;
        quotedPost?: ReturnType<typeof extractQuotedPost>;
      }[] = [];
      const agent = agentRef.current;
      if (agent?.did) {
        try {
          setFetchStatus("Fetching Bluesky mentions...");
          const response = await agent.listNotifications({ limit: 50 });
          const mentionNotifs = response.data.notifications
            .filter((n: { reason: string }) => n.reason === "mention" || n.reason === "reply");

          // Batch-fetch hydrated post views to get embed/image data
          const uris = mentionNotifs.map((n: { uri: string }) => n.uri);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const embedMap = new Map<string, any>();
          if (uris.length > 0) {
            try {
              const postsRes = await agent.getPosts({ uris });
              for (const p of postsRes.data.posts) {
                embedMap.set(p.uri, (p as unknown as { embed?: unknown }).embed);
              }
            } catch (err) {
              console.warn("Failed to batch-fetch post embeds:", err);
            }
          }

          blueskyPosts = mentionNotifs.map((n: { author: { did: string; handle: string }; record: unknown; uri: string; cid: string; indexedAt: string }) => {
              const record = n.record as { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string } } };
              const text = record?.text || "";
              const contentHtml = facetsToHtml(text, record?.facets);
              const embed = embedMap.get(n.uri);
              return {
                uri: n.uri,
                cid: n.cid,
                authorDid: n.author.did,
                authorHandle: n.author.handle,
                text,
                contentHtml,
                createdAt: n.indexedAt,
                replyToUri: record?.reply?.parent?.uri || undefined,
                postType: "mention",
                images: extractBlueskyImages(embed),
                quotedPost: extractQuotedPost(embed),
              };
            });
        } catch (err) {
          console.error("Bluesky mentions fetch error:", err instanceof Error ? err.message : err);
          if (isAuthError(err)) {
            setBlueskyAgent(null);
            agentRef.current = null;
            setFetchError("Your Bluesky session has expired. Please reload the page to reconnect.");
          } else {
            setFetchError("Bluesky fetch failed — check your connection.");
          }
        }
      }

      setFetchStatus("Fetching Mastodon mentions...");
      const res = await fetch("/api/posts/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "all", type: "mentions", posts: blueskyPosts }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("Mentions fetch error:", data.error);
        if (res.status === 401) {
          setFetchError("Your Mastodon session has expired. Please reconnect your account.");
        }
      } else {
        const data = await res.json();
        setPosts(data.posts);
        setNextCursor(data.nextCursor);
      }
    } catch (err) {
      console.error("Mentions fetch error:", err);
    } finally {
      setFetching(false);
      setFetchStatus("");
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refreshFeed, fetching);

  // Cache mentions state
  useEffect(() => {
    if (posts.length > 0) {
      sessionStorage.setItem(
        "mentions_cache",
        JSON.stringify({ posts, nextCursor })
      );
    }
  }, [posts, nextCursor]);

  // Save scroll position
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function handleScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        sessionStorage.setItem("mentions_scroll", String(window.scrollY));
      }, 100);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  // Restore from cache or fetch fresh
  useEffect(() => {
    const cached = sessionStorage.getItem("mentions_cache");
    if (cached) {
      try {
        const { posts: cachedPosts, nextCursor: cachedCursor } = JSON.parse(cached);
        if (cachedPosts?.length > 0) {
          setPosts(cachedPosts);
          setNextCursor(cachedCursor);
          setLoading(false);
          const savedScroll = sessionStorage.getItem("mentions_scroll");
          if (savedScroll) {
            pendingScrollRestore.current = parseInt(savedScroll);
          }
          return;
        }
      } catch {
        // Fall through
      }
    }
    const timer = setTimeout(refreshFeed, 500);
    return () => clearTimeout(timer);
  }, [refreshFeed]);

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
      const data = await fetchMentions(nextCursor);
      setPosts((prev) => [...prev, ...data.posts]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Load more error:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppLayout>

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

      {!loading && posts.length === 0 && (
        <p className="text-muted" style={{ textAlign: "center", padding: "40px 0" }}>
          No mentions yet. Pull down to refresh.
        </p>
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
