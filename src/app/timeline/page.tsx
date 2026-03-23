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
  alsoPostedOn: string[];
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
              images: extractBlueskyImages(item.post.embed),
              quotedPost: extractQuotedPost(item.post.embed),
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
