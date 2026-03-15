"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getBlueskyOAuthClient,
  getBlueskyAgent,
  setBlueskyAgent,
} from "@/lib/bluesky-oauth";
import { PostCard } from "@/components/PostCard";

interface PostData {
  id: number;
  platform: string;
  content: string | null;
  contentHtml: string | null;
  media: Array<{ type: string; url: string; alt: string }> | null;
  repostOfId: string | null;
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
  alsoPostedOn: string[];
}

export default function TimelinePage() {
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);

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
        // No Bluesky session — that's okay, we'll still show Mastodon posts
      }
    })();
  }, []);

  const fetchTimeline = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`/api/timeline?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      return data;
    },
    []
  );

  // Fetch posts from both platforms, then load the timeline
  const refreshFeed = useCallback(async () => {
    setFetching(true);
    setFetchStatus("Fetching posts...");

    try {
      // Fetch from both platforms in parallel
      const promises: Promise<unknown>[] = [];

      // Bluesky: client-side fetch via agent
      const agent = agentRef.current;
      if (agent?.did) {
        promises.push(
          (async () => {
            setFetchStatus("Fetching Bluesky timeline...");
            const response = await agent.getTimeline({ limit: 50 });
            const blueskyPosts = response.data.feed.map((item) => ({
              uri: item.post.uri,
              authorDid: item.post.author.did,
              authorHandle: item.post.author.handle,
              text:
                (item.post.record as { text?: string })?.text || "",
              createdAt: item.post.indexedAt,
              likeCount: item.post.likeCount,
              repostCount: item.post.repostCount,
              replyCount: item.post.replyCount,
              replyToUri:
                (item.post.record as { reply?: { parent?: { uri?: string } } })
                  ?.reply?.parent?.uri || undefined,
              repostOfUri: item.reason ? item.post.uri : undefined,
              images:
                (
                  item.post.embed as {
                    images?: Array<{
                      thumb: string;
                      alt: string;
                      fullsize: string;
                    }>;
                  }
                )?.images?.map((img) => ({
                  url: img.fullsize || img.thumb,
                  alt: img.alt || "",
                })) || [],
            }));

            await fetch("/api/posts/fetch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                platform: "bluesky",
                posts: blueskyPosts,
              }),
            });
          })()
        );
      }

      // Mastodon: server-side fetch
      promises.push(
        (async () => {
          setFetchStatus("Fetching Mastodon timeline...");
          await fetch("/api/posts/fetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: "mastodon" }),
          });
        })()
      );

      await Promise.allSettled(promises);
    } catch (err) {
      console.error("Feed fetch error:", err);
    }

    setFetching(false);
    setFetchStatus("");

    // Now load the merged timeline
    setLoading(true);
    try {
      const data = await fetchTimeline();
      setPosts(data.posts);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Timeline load error:", err);
    } finally {
      setLoading(false);
    }
  }, [fetchTimeline]);

  useEffect(() => {
    // Small delay to let agent initialize
    const timer = setTimeout(refreshFeed, 500);
    return () => clearTimeout(timer);
  }, [refreshFeed]);

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
    <main className="main">
      <div className="header">
        <img
          src="/logo-horizontal.svg"
          alt="alpaca.blue"
          className="header-logo"
        />
        <p>Timeline</p>
      </div>

      <nav className="page-nav">
        <a href="/" className="link">
          Accounts
        </a>
        <span className="nav-sep">/</span>
        <a href="/identities" className="link">
          Identities
        </a>
        <span className="nav-sep">/</span>
        <span className="nav-current">Timeline</span>
      </nav>

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
          No posts yet. Make sure you&apos;ve connected and imported your accounts, then hit Refresh.
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
    </main>
  );
}
