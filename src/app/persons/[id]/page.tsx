"use client";

// Person view: all posts across a resolved person's linked identities. The
// identity cards come from /api/graph/identities (matching data — server-owned),
// but the posts are fetched client-side from each identity's author feed and
// merged/deduped in the browser. No server posts route.

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { Avatar } from "@/components/Avatar";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { BlueskyClient } from "@/lib/client/bluesky";
import { getMastodonCredentials, type MastodonCredentials } from "@/lib/client/mastodon";
import { getIdentityMap, enrichAuthor, fetchPostsForIdentity } from "@/lib/client/identities";
import { mergeTimeline } from "@/lib/client/dedup";
import { likePost, repostPost } from "@/lib/client/actions";
import { ClientActionsContext, type ClientActions } from "@/lib/client/ClientActionsContext";
import type { ClientPost } from "@/lib/client/types";

interface Identity {
  id: number;
  platform: string;
  handle: string;
  did: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  bannerUrl: string | null;
}

export default function PersonPage() {
  const params = useParams();
  const router = useRouter();
  const personId = params.id as string;

  const [personName, setPersonName] = useState("");
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [posts, setPosts] = useState<ClientPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const bluesky = useRef<BlueskyClient | null>(null);
  const masto = useRef<MastodonCredentials | null>(null);
  const ready = useRef(false);
  const inFlight = useRef(false);
  const identitiesRef = useRef<Identity[]>([]);
  const allPosts = useRef<ClientPost[]>([]); // accumulated across pages
  const cursors = useRef<Record<number, string | null>>({}); // identityId → next cursor (null = exhausted)

  // Fetches a page of every linked identity's feed and re-renders the merged
  // view. reset=true clears accumulators and starts from the top.
  const fetchPage = useCallback(async (reset: boolean) => {
    const clients = { bluesky: bluesky.current, mastodon: masto.current };
    const results = await Promise.all(
      identitiesRef.current.map(async (i) => {
        const cursor = reset ? undefined : cursors.current[i.id];
        if (!reset && cursor === null) return { id: i.id, posts: [] as ClientPost[], cursor: null };
        try {
          const r = await fetchPostsForIdentity(i, clients, { cursor: cursor ?? undefined });
          return { id: i.id, posts: r.posts, cursor: r.cursor };
        } catch (err) {
          console.error("[person] identity feed failed:", err);
          return { id: i.id, posts: [] as ClientPost[], cursor: cursors.current[i.id] ?? null };
        }
      }),
    );
    for (const res of results) {
      cursors.current[res.id] = res.cursor;
      allPosts.current.push(...res.posts);
    }
    const map = await getIdentityMap();
    const all = [...allPosts.current];
    for (const p of all) enrichAuthor(p, map);
    all.sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    setPosts(mergeTimeline(all));
    setHasMore(Object.values(cursors.current).some((c) => c !== null));
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFetching(true);
    try {
      if (!ready.current) {
        masto.current = await getMastodonCredentials();
        bluesky.current = await BlueskyClient.create();
        ready.current = true;
      }
      // Identity cards + which identities belong to this person.
      const identRes = await fetch("/api/graph/identities");
      const identData = await identRes.json();
      const person = identData.persons?.find((p: { id: number }) => p.id === parseInt(personId));
      const personIdentities: Identity[] = person?.identities || [];
      setPersonName(person?.displayName || "Unknown");
      setIdentities(personIdentities);
      identitiesRef.current = personIdentities;

      allPosts.current = [];
      cursors.current = {};
      await fetchPage(true);
    } catch (err) {
      console.error("Failed to load person:", err);
    } finally {
      setFetching(false);
      setLoading(false);
      inFlight.current = false;
    }
  }, [personId, fetchPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(false);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, fetchPage]);

  useEffect(() => { load(); }, [load]);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(load, fetching);

  const actions: ClientActions = {
    like: (post) => likePost(post, { bluesky: bluesky.current, mastodon: masto.current }),
    repost: (post) => repostPost(post, { bluesky: bluesky.current, mastodon: masto.current }),
  };

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

      {loading && <div className="spinner-container"><div className="spinner" /></div>}

      {!loading && (
        <>
          {personName && <h1 className="section-title" style={{ marginTop: 8 }}>{personName}</h1>}

          {identities.length > 0 && (
            <section className="section">
              <h2 className="section-title">Accounts</h2>
              <div className="person-identities-list">
                {identities.map((i) => (
                  <div key={i.id} className="person-identity-card">
                    {i.bannerUrl && (
                      <div className="person-identity-banner" style={{ backgroundImage: `url(${i.bannerUrl})` }} />
                    )}
                    <div className="person-identity-row">
                      {i.avatarUrl && (
                        <Avatar identityId={i.id} src={i.avatarUrl} className="person-identity-avatar" />
                      )}
                      <span className={`platform-badge ${i.platform}`}>
                        {i.platform === "bluesky" ? "B" : "M"}
                      </span>
                      <span className="person-identity-handle">{i.handle}</span>
                    </div>
                    {i.bio && (
                      i.platform === "mastodon" ? (
                        <div className="person-identity-bio" dangerouslySetInnerHTML={{ __html: i.bio }} />
                      ) : (
                        <p className="person-identity-bio person-identity-bio-text">{i.bio}</p>
                      )
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <h2 className="section-title">Posts {posts.length > 0 && `(${posts.length})`}</h2>
            {posts.length === 0 && <p className="text-muted">No posts found for this person.</p>}
            <ClientActionsContext.Provider value={actions}>
              <div className="timeline-feed">
                {posts.map((post) => (
                  <PostCard key={`${post.platform}-${post.platformPostId}`} post={post} />
                ))}
                {hasMore && (
                  <div className="load-more">
                    <button onClick={loadMore} disabled={loadingMore} className="btn btn-outline load-more-btn">
                      {loadingMore ? "Loading..." : "Load more"}
                    </button>
                  </div>
                )}
              </div>
            </ClientActionsContext.Provider>
          </section>
        </>
      )}
    </AppLayout>
  );
}
