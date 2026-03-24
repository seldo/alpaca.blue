"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import {
  getBlueskyOAuthClient,
  getBlueskyAgent,
  setBlueskyAgent,
} from "@/lib/bluesky-oauth";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";

interface PostData {
  id: number;
  platform: string;
  platformPostId: string;
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

export default function MentionsPage() {
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);
  const pendingScrollRestore = useRef<number | null>(null);

  // Initialize Bluesky agent
  useEffect(() => {
    const existing = getBlueskyAgent();
    if (existing) {
      agentRef.current = existing;
      return;
    }

    (async () => {
      try {
        const client = await getBlueskyOAuthClient();
        const result = await client.init();
        if (result?.session) {
          const { Agent } = await import("@atproto/api");
          const agent = new Agent(result.session);
          agentRef.current = agent;
          setBlueskyAgent(agent);
        }
      } catch {
        // No Bluesky session
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
    sessionStorage.removeItem("mentions_cache");
    sessionStorage.removeItem("mentions_scroll");
    setFetching(true);
    setFetchStatus("Fetching mentions...");

    try {
      const promises: Promise<unknown>[] = [];
      const agent = agentRef.current;

      // Bluesky mentions via notifications
      if (agent?.did) {
        promises.push(
          (async () => {
            setFetchStatus("Fetching Bluesky mentions...");
            const response = await agent.listNotifications({ limit: 50 });
            const mentionPosts = response.data.notifications
              .filter((n: { reason: string }) => n.reason === "mention" || n.reason === "reply")
              .map((n: { author: { did: string; handle: string }; record: unknown; uri: string; indexedAt: string }) => {
                const record = n.record as { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string } } };
                const text = record?.text || "";
                const contentHtml = facetsToHtml(text, record?.facets);
                return {
                  uri: n.uri,
                  authorDid: n.author.did,
                  authorHandle: n.author.handle,
                  text,
                  contentHtml,
                  createdAt: n.indexedAt,
                  replyToUri: record?.reply?.parent?.uri || undefined,
                  postType: "mention",
                };
              });
            if (mentionPosts.length > 0) {
              await fetch("/api/posts/fetch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ platform: "bluesky", posts: mentionPosts }),
              });
            }
          })()
        );
      }

      // Mastodon mentions
      promises.push(
        (async () => {
          setFetchStatus("Fetching Mastodon mentions...");
          await fetch("/api/posts/fetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: "mastodon", type: "mentions" }),
          });
        })()
      );

      await Promise.allSettled(promises);
    } catch (err) {
      console.error("Mentions fetch error:", err);
    }

    setFetching(false);
    setFetchStatus("");

    setLoading(true);
    try {
      const data = await fetchMentions();
      setPosts(data.posts);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Mentions load error:", err);
    } finally {
      setLoading(false);
    }
  }, [fetchMentions]);

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
      <div className="timeline-actions">
        <button
          onClick={refreshFeed}
          disabled={fetching}
          className="btn btn-outline"
        >
          {fetching ? fetchStatus || "Refreshing..." : "Refresh"}
        </button>
      </div>

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && posts.length === 0 && (
        <p className="text-muted" style={{ textAlign: "center", padding: "40px 0" }}>
          No mentions yet. Hit Refresh to check for new mentions.
        </p>
      )}

      {!loading && (
        <div className="timeline-feed">
          {posts.map((post) => (
            <PostCard key={`${post.platform}-${post.id}`} post={post} />
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
