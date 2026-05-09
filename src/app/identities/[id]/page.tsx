"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { Avatar } from "@/components/Avatar";
import { usePullToRefresh } from "@/lib/usePullToRefresh";

interface IdentityStats {
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
}

interface Identity {
  id: number;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  personId: number | null;
  bio: string | null;
  bioHtml: string | null;
  bannerUrl: string | null;
  stats: IdentityStats;
  isFollowing: boolean;
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
  alsoPostedOn: Array<{ platform: string; postUrl: string | null; platformPostId: string; platformPostCid: string | null; threadRootId: string | null; threadRootCid: string | null }>;
}

type Tab = "posts" | "replies" | "media" | "videos";
const TABS: { key: Tab; label: string }[] = [
  { key: "posts", label: "Posts" },
  { key: "replies", label: "Replies" },
  { key: "media", label: "Media" },
  { key: "videos", label: "Videos" },
];

export default function IdentityPage() {
  const params = useParams();
  const router = useRouter();
  const identityId = params.id as string;

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("posts");
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const isFetchingRef = useRef(false);
  const pendingScrollRestore = useRef<number | null>(null);

  const cacheKey = `identity_cache_${identityId}_${tab}`;
  const scrollKey = `identity_scroll_${identityId}_${tab}`;

  const fetchData = useCallback(async (selectedTab: Tab) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setFetching(true);

    try {
      const res = await fetch(`/api/identities/${identityId}/posts?limit=50&tab=${selectedTab}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setIdentity(data.identity);
      setPosts(data.posts || []);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Failed to load identity:", err);
    } finally {
      setFetching(false);
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [identityId]);

  // Persist state in sessionStorage so back-nav restores instantly. We only
  // save when posts is non-empty: switching tabs clears `posts` to [] and
  // would otherwise trample the destination tab's cached data before the
  // load effect can read it.
  useEffect(() => {
    if (identity && posts.length > 0) {
      sessionStorage.setItem(cacheKey, JSON.stringify({ identity, posts, nextCursor }));
    }
  }, [identity, posts, nextCursor, cacheKey]);

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

  // On mount or tab change: hydrate from cache if we have one, otherwise fetch.
  // Requires non-empty posts — an old cache with `identity` but no posts (from
  // a prior buggy save) would otherwise short-circuit and never refetch.
  useEffect(() => {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const { identity: i, posts: p, nextCursor: c } = JSON.parse(cached);
        if (i && Array.isArray(p) && p.length > 0) {
          setIdentity(i);
          setPosts(p);
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
    setLoading(true);
    fetchData(tab);
  }, [fetchData, cacheKey, scrollKey, tab]);

  useLayoutEffect(() => {
    if (pendingScrollRestore.current !== null && posts.length > 0) {
      window.scrollTo(0, pendingScrollRestore.current);
      pendingScrollRestore.current = null;
    }
  }, [posts]);

  const refresh = useCallback(() => {
    sessionStorage.removeItem(cacheKey);
    sessionStorage.removeItem(scrollKey);
    return fetchData(tab);
  }, [fetchData, tab, cacheKey, scrollKey]);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refresh, fetching);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/identities/${identityId}/posts?limit=50&tab=${tab}&cursor=${nextCursor}`);
      const data = await res.json();
      setPosts((prev) => [...prev, ...data.posts]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Load more error:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  function selectTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setPosts([]);
    setNextCursor(null);
  }

  async function toggleFollow() {
    if (!identity || followBusy) return;
    setFollowBusy(true);
    const wasFollowing = identity.isFollowing;
    // Optimistic UI
    setIdentity({ ...identity, isFollowing: !wasFollowing });
    try {
      const res = await fetch(`/api/identities/${identityId}/follow`, {
        method: wasFollowing ? "DELETE" : "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Follow failed");
      }
    } catch (err) {
      // Roll back on failure
      setIdentity({ ...identity, isFollowing: wasFollowing });
      const message = err instanceof Error ? err.message : "Follow failed";
      alert(message);
    } finally {
      setFollowBusy(false);
    }
  }

  const displayName = identity?.displayName || identity?.handle || "Profile";

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

      {!loading && identity && (
        <>
          <div className="profile-hero">
            <div className="profile-hero-banner-wrap">
              {identity.bannerUrl ? (
                <div className="profile-hero-banner" style={{ backgroundImage: `url(${identity.bannerUrl})` }} />
              ) : (
                <div className="profile-hero-banner profile-hero-banner-empty" />
              )}
              <div className="profile-hero-actions">
                <button
                  className={`btn ${identity.isFollowing ? "btn-outline" : "btn-primary"} profile-follow-btn`}
                  onClick={toggleFollow}
                  disabled={followBusy}
                >
                  {identity.isFollowing ? "Following" : "Follow"}
                </button>
              </div>
              <div className="profile-hero-avatar">
                {identity.avatarUrl && (
                  <Avatar identityId={identity.id} src={identity.avatarUrl} className="profile-hero-avatar-img" />
                )}
              </div>
            </div>
            <div className="profile-hero-body">
              <h1 className="profile-hero-displayname">{displayName}</h1>
              <div className="profile-hero-handle">
                <span className={`platform-badge ${identity.platform}`}>
                  {identity.platform === "bluesky" ? "B" : "M"}
                </span>
                {(() => {
                  // Mastodon handles are stored with a leading @; strip so
                  // the rendered "@" doesn't double up.
                  const handle = identity.handle.replace(/^@/, "");
                  return identity.profileUrl ? (
                    <a href={identity.profileUrl} target="_blank" rel="noopener noreferrer" className="profile-hero-handle-link">
                      @{handle}
                    </a>
                  ) : (
                    <span>@{handle}</span>
                  );
                })()}
              </div>

              <ProfileStats stats={identity.stats} />

              {identity.bioHtml && (
                <div className="profile-hero-bio" dangerouslySetInnerHTML={{ __html: identity.bioHtml }} />
              )}

              {identity.personId && (
                <a href={`/persons/${identity.personId}`} className="profile-hero-merged-link">
                  View merged profile →
                </a>
              )}
            </div>
          </div>

          <nav className="profile-tabs" role="tablist" aria-label="Posts filter">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                className={`profile-tab${tab === t.key ? " profile-tab-active" : ""}`}
                onClick={() => selectTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <section className="section">
            {fetching && posts.length === 0 && (
              <div className="spinner-container"><div className="spinner" /></div>
            )}

            {!fetching && posts.length === 0 && (
              <p className="text-muted" style={{ textAlign: "center", padding: "32px 0" }}>
                Nothing to show.
              </p>
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

function ProfileStats({ stats }: { stats: IdentityStats }) {
  const items: Array<{ value: number | null; label: string }> = [
    { value: stats.followersCount, label: "followers" },
    { value: stats.followingCount, label: "following" },
    { value: stats.postsCount, label: "posts" },
  ];
  if (items.every((i) => i.value === null)) return null;
  return (
    <div className="profile-hero-stats">
      {items.map((i) => i.value === null ? null : (
        <span key={i.label} className="profile-hero-stat">
          <strong>{formatStat(i.value)}</strong> <span className="text-muted">{i.label}</span>
        </span>
      ))}
    </div>
  );
}

function formatStat(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`.replace(".0K", "K");
  return n.toString();
}
