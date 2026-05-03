"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from "react";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { PostCard } from "@/components/PostCard";
import { ReactionCard } from "@/components/ReactionCard";
import { AppLayout } from "@/components/AppHeader";
import type { ReactionGroup } from "@/lib/reactions";

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
  alsoPostedOn: Array<{ platform: string; postUrl: string | null; platformPostId: string; platformPostCid: string | null; threadRootId: string | null; threadRootCid: string | null }>;
  replyToMe?: boolean;
  linkCard?: { url: string; title: string; description?: string; thumb?: string } | null;
}

export default function MentionsPage() {
  const [posts, setPosts] = useState<PostData[]>([]);
  const [reactionGroups, setReactionGroups] = useState<ReactionGroup[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pendingScrollRestore = useRef<number | null>(null);
  const isFetchingRef = useRef(false);
  const fetchControllerRef = useRef<AbortController | null>(null);

  const feed = useMemo(() => {
    type FeedItem = { sortKey: string; kind: "post"; data: PostData } | { sortKey: string; kind: "reaction"; data: ReactionGroup };
    const items: FeedItem[] = [
      ...posts.map((p) => ({ sortKey: p.postedAt, kind: "post" as const, data: p })),
      ...reactionGroups.map((g) => ({ sortKey: g.latestAt, kind: "reaction" as const, data: g })),
    ];
    return items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [posts, reactionGroups]);

  const fetchMentionsCursor = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams({ limit: "50", type: "mentions" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`/api/timeline?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  }, []);

  const refreshFeed = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    sessionStorage.removeItem("mentions_cache");
    sessionStorage.removeItem("mentions_scroll");
    if (!silent) setFetching(true);
    setFetchError(null);

    const controller = new AbortController();
    fetchControllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const [mentionsResult, reactionsResult] = await Promise.allSettled([
        fetch("/api/timeline?type=mentions&limit=50", { signal: controller.signal }),
        fetch("/api/reactions/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}), signal: controller.signal }),
      ]);

      if (mentionsResult.status === "fulfilled" && mentionsResult.value.ok) {
        const data = await mentionsResult.value.json();
        setPosts(data.posts);
        setNextCursor(data.nextCursor);
      } else if (mentionsResult.status === "fulfilled") {
        if (mentionsResult.value.status === 401) {
          setFetchError("Your session has expired. Please log out and log back in.");
        }
      }

      if (reactionsResult.status === "fulfilled" && reactionsResult.value.ok) {
        const data = await reactionsResult.value.json();
        setReactionGroups(data.reactionGroups || []);
      }
    } catch (err) {
      console.error("Mentions fetch error:", err);
    } finally {
      clearTimeout(timeout);
      if (!silent) setFetching(false);
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    function handleVisibilityChange() {
      if (!document.hidden && isFetchingRef.current) {
        fetchControllerRef.current?.abort();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const heartbeat = useCallback(() => {
    if (document.hidden) return;
    fetch("/api/posts/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(heartbeat, 7000);
    return () => clearInterval(id);
  }, [heartbeat]);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refreshFeed, fetching);

  useEffect(() => {
    if (posts.length > 0 || reactionGroups.length > 0) {
      sessionStorage.setItem("mentions_cache", JSON.stringify({ posts, reactionGroups, nextCursor }));
    }
  }, [posts, reactionGroups, nextCursor]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function handleScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => { sessionStorage.setItem("mentions_scroll", String(window.scrollY)); }, 100);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => { clearTimeout(timer); window.removeEventListener("scroll", handleScroll); };
  }, []);

  useEffect(() => {
    const cached = sessionStorage.getItem("mentions_cache");
    if (cached) {
      try {
        const { posts: cachedPosts, reactionGroups: cachedReactions, nextCursor: cachedCursor } = JSON.parse(cached);
        if (cachedPosts?.length > 0 || cachedReactions?.length > 0) {
          setPosts(cachedPosts || []);
          setReactionGroups(cachedReactions || []);
          setNextCursor(cachedCursor);
          setLoading(false);
          const savedScroll = sessionStorage.getItem("mentions_scroll");
          if (savedScroll) pendingScrollRestore.current = parseInt(savedScroll);
          // Still kick off a background refresh so navigating in shows the
          // latest mentions; cached content paints first so there's no flicker.
          // Silent — pull-to-refresh remains the only thing that surfaces
          // the "Fetching..." indicator.
          refreshFeed({ silent: true });
          return;
        }
      } catch { /* fall through */ }
    }
    const timer = setTimeout(refreshFeed, 500);
    return () => clearTimeout(timer);
  }, [refreshFeed]);

  useLayoutEffect(() => {
    if (pendingScrollRestore.current !== null && feed.length > 0) {
      window.scrollTo(0, pendingScrollRestore.current);
      pendingScrollRestore.current = null;
    }
  }, [feed]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchMentionsCursor(nextCursor);
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

      {fetching && (
        <p className="text-muted" style={{ textAlign: "center", padding: "4px 0", fontSize: "0.85em" }}>Fetching mentions...</p>
      )}

      {fetchError && (
        <p className="text-muted" style={{ textAlign: "center", padding: "8px 0", color: "var(--color-error, #c0392b)" }}>
          {fetchError}{" "}
          {fetchError.includes("expired") && (
            <button onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}>Log out</button>
          )}
        </p>
      )}

      {loading && <div className="spinner-container"><div className="spinner" /></div>}

      {!loading && feed.length === 0 && (
        <p className="text-muted" style={{ textAlign: "center", padding: "40px 0" }}>
          No mentions or reactions yet. Pull down to refresh.
        </p>
      )}

      {!loading && (
        <div className="timeline-feed">
          {feed.map((item) =>
            item.kind === "reaction" ? (
              <ReactionCard key={item.data.id} group={item.data} />
            ) : (
              <PostCard key={`${item.data.platform}-${item.data.id}`} post={item.data} />
            )
          )}
          {nextCursor && (
            <div className="load-more">
              <button onClick={loadMore} disabled={loadingMore} className="btn btn-outline load-more-btn">
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </AppLayout>
  );
}
