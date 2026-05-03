"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { useRouter } from "next/navigation";
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
  alsoPostedOn: Array<{ platform: string; postUrl: string | null; platformPostId: string; platformPostCid: string | null; threadRootId: string | null; threadRootCid: string | null }>;
  linkCard: { url: string; title: string; description?: string; thumb?: string } | null;
}

export default function TimelinePage() {
  const router = useRouter();
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const pendingScrollRestore = useRef<number | null>(null);
  const isFetchingRef = useRef(false);
  const fetchControllerRef = useRef<AbortController | null>(null);

  const fetchTimeline = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`/api/timeline?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  }, []);

  const refreshFeed = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    sessionStorage.removeItem("timeline_cache");
    sessionStorage.removeItem("timeline_scroll");
    if (!silent) setFetching(true);
    setFetchError(null);

    const controller = new AbortController();
    fetchControllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch("/api/timeline?limit=50", { signal: controller.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setFetchError("Your session has expired. Please log out and log back in.");
        } else {
          console.error("Feed fetch error:", data.error);
        }
      } else {
        const data = await res.json();
        setPosts(data.posts);
        setNextCursor(data.nextCursor);
      }
    } catch (err) {
      console.error("Feed fetch error:", err);
    } finally {
      clearTimeout(timeout);
      if (!silent) setFetching(false);
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  // On mobile PWA, setTimeout is suspended when backgrounded, so the 15s abort
  // never fires. Abort any stuck fetch immediately when the app returns to foreground.
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

  // After posting: bust debounce/cache then do a full UI refresh
  const forceRefresh = useCallback(async () => {
    await fetch("/api/posts/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    }).catch(() => {});
    refreshFeed();
  }, [refreshFeed]);

  useEffect(() => {
    const id = setInterval(heartbeat, 7000);
    return () => clearInterval(id);
  }, [heartbeat]);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refreshFeed, fetching);

  useEffect(() => {
    if (posts.length > 0) {
      sessionStorage.setItem("timeline_cache", JSON.stringify({ posts, nextCursor }));
    }
  }, [posts, nextCursor]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function handleScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        sessionStorage.setItem("timeline_scroll", String(window.scrollY));
      }, 100);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => { clearTimeout(timer); window.removeEventListener("scroll", handleScroll); };
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
          if (savedScroll) pendingScrollRestore.current = parseInt(savedScroll);
          // Still kick off a background refresh so navigating in shows the
          // latest posts; cached content paints first so there's no flicker.
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

  useEffect(() => {
    if (!loading && posts.length === 0) {
      router.replace("/settings");
    }
  }, [loading, posts.length, router]);

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
    <AppLayout>
      {composeOpen ? (
        <div className="create-post-modal-backdrop" onClick={() => setComposeOpen(false)}>
          <div className="create-post-modal" onClick={(e) => e.stopPropagation()}>
            <p className="create-post-modal-title">New Post</p>
            <CreatePost
              onClose={() => setComposeOpen(false)}
              onPosted={() => { setComposeOpen(false); setTimeout(forceRefresh, 1000); }}
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

      {fetching && (
        <p className="text-muted" style={{ textAlign: "center", padding: "4px 0", fontSize: "0.85em" }}>Fetching posts...</p>
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

      {!loading && (
        <div className="timeline-feed">
          {posts.map((post) => (
            <PostCard key={`${post.platform}-${post.id}`} post={post} />
          ))}
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
