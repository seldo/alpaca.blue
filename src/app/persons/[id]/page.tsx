"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { usePullToRefresh } from "@/lib/usePullToRefresh";

interface Identity {
  id: number;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

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
  person: { id: number; displayName: string | null } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
}

export default function PersonPage() {
  const params = useParams();
  const router = useRouter();
  const personId = params.id as string;

  const [personName, setPersonName] = useState<string>("");
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const isFetchingRef = useRef(false);
  const pendingScrollRestore = useRef<number | null>(null);

  const cacheKey = `person_cache_${personId}`;
  const scrollKey = `person_scroll_${personId}`;

  const fetchData = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    sessionStorage.removeItem(cacheKey);
    sessionStorage.removeItem(scrollKey);
    setFetching(true);

    try {
      const [identRes, postsRes] = await Promise.all([
        fetch("/api/graph/identities"),
        fetch(`/api/persons/${personId}/posts?limit=50`),
      ]);

      const identData = await identRes.json();
      const person = identData.persons?.find(
        (p: { id: number }) => p.id === parseInt(personId)
      );
      if (person) {
        setPersonName(person.displayName || "Unknown");
        setIdentities(person.identities || []);
      }

      const postsData = await postsRes.json();
      if (postsData.posts) {
        setPosts(postsData.posts);
        setNextCursor(postsData.nextCursor);
      }
    } catch (err) {
      console.error("Failed to load person:", err);
    } finally {
      setFetching(false);
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [personId, cacheKey, scrollKey]);

  // Cache state
  useEffect(() => {
    if (posts.length > 0 || identities.length > 0) {
      sessionStorage.setItem(cacheKey, JSON.stringify({ personName, identities, posts, nextCursor }));
    }
  }, [personName, identities, posts, nextCursor, cacheKey]);

  // Save scroll position
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function handleScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        sessionStorage.setItem(scrollKey, String(window.scrollY));
      }, 100);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", handleScroll);
    };
  }, [scrollKey]);

  // Restore from cache or fetch fresh
  useEffect(() => {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const { personName: n, identities: ids, posts: p, nextCursor: c } = JSON.parse(cached);
        if (p?.length > 0 || ids?.length > 0) {
          setPersonName(n || "");
          setIdentities(ids || []);
          setPosts(p || []);
          setNextCursor(c);
          setLoading(false);
          const savedScroll = sessionStorage.getItem(scrollKey);
          if (savedScroll) pendingScrollRestore.current = parseInt(savedScroll);
          return;
        }
      } catch {
        // fall through
      }
    }
    fetchData();
  }, [fetchData, cacheKey, scrollKey]);

  useLayoutEffect(() => {
    if (pendingScrollRestore.current !== null && posts.length > 0) {
      window.scrollTo(0, pendingScrollRestore.current);
      pendingScrollRestore.current = null;
    }
  }, [posts]);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(fetchData, fetching);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/persons/${personId}/posts?limit=50&cursor=${nextCursor}`
      );
      const data = await res.json();
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
      <button className="back-btn" onClick={() => router.back()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back
      </button>

      {(pullDistance > 0 || pullRefreshing) && (
        <div className="pull-indicator" style={{ height: pullRefreshing ? 48 : pullDistance * 0.5 }}>
          <div className="spinner" style={{ opacity: pullRefreshing ? 1 : pullDistance > 0 ? 0.4 + 0.6 * (pullDistance / 72) : 0 }} />
        </div>
      )}

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && (
        <>
          {identities.length > 0 && (
            <section className="section">
              <h2 className="section-title">Accounts</h2>
              <div className="person-identities-list">
                {identities.map((i) => (
                  <div key={i.id} className="person-identity-row">
                    {i.avatarUrl && (
                      <img
                        src={i.avatarUrl}
                        alt=""
                        className="person-identity-avatar"
                      />
                    )}
                    <span className={`platform-badge ${i.platform}`}>
                      {i.platform === "bluesky" ? "B" : "M"}
                    </span>
                    <span className="person-identity-handle">{i.handle}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <h2 className="section-title">
              Posts {posts.length > 0 && `(${posts.length})`}
            </h2>

            {posts.length === 0 && (
              <p className="text-muted">No posts fetched yet for this person.</p>
            )}

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
          </section>
        </>
      )}
    </AppLayout>
  );
}
