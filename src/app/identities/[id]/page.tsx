"use client";

// Single identity view: header (handle/avatar/bio/banner) from
// /api/graph/identities, live stats + follow state from the platform, and the
// identity's posts fetched client-side with posts/replies/media/videos tabs and
// cursor pagination. Follow/unfollow writes go directly to the platform.

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { Avatar } from "@/components/Avatar";
import { PullToRefresh } from "@/components/PullToRefresh";
import { BlueskyClient } from "@/lib/client/bluesky";
import {
  getMastodonCredentials,
  fetchMastodonAuthorStatuses,
  fetchMastodonAccountById,
  fetchMastodonRelationship,
  lookupMastodonAccount,
  mastodonFollow,
  type MastodonCredentials,
} from "@/lib/client/mastodon";
import { getIdentityMap, enrichAuthor } from "@/lib/client/identities";
import { mergeTimeline } from "@/lib/client/dedup";
import { likePost, repostPost } from "@/lib/client/actions";
import { ClientActionsContext, type ClientActions } from "@/lib/client/ClientActionsContext";
import { extractBlueskyFollowUri } from "@/lib/profile-meta";
import type { ClientPost } from "@/lib/client/types";

interface Identity {
  id: number;
  personId: number | null;
  platform: string;
  handle: string;
  did: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  bannerUrl: string | null;
  profileUrl: string | null;
}

interface Stats {
  followers: number | null;
  following: number | null;
  posts: number | null;
}

type Tab = "posts" | "replies" | "media" | "videos";
const TABS: { key: Tab; label: string }[] = [
  { key: "posts", label: "Posts" },
  { key: "replies", label: "Replies" },
  { key: "media", label: "Media" },
  { key: "videos", label: "Videos" },
];

function findIdentity(data: { persons?: { identities?: Identity[] }[]; unlinked?: Identity[] }, id: number): Identity | null {
  const all: Identity[] = [
    ...(data.persons || []).flatMap((p) => p.identities || []),
    ...(data.unlinked || []),
  ];
  return all.find((i) => i.id === id) ?? null;
}

// Tabs filter the author feed; some filtering is server-side, some client-side.
function applyTabFilter(posts: ClientPost[], tab: Tab): ClientPost[] {
  if (tab === "replies") return posts.filter((p) => p.replyToId);
  if (tab === "videos") return posts.filter((p) => p.media?.some((m) => m.type === "video" || m.type === "gifv"));
  return posts;
}

export default function IdentityPage() {
  const params = useParams();
  const router = useRouter();
  // useParams can hand back the segment still percent-encoded (e.g. the
  // "<platform>:<handle>" actor key), so decode defensively. Numeric ids and
  // already-decoded values pass through unchanged.
  const rawId = params.id as string;
  const identityId = (() => {
    try { return decodeURIComponent(rawId); } catch { return rawId; }
  })();

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("posts");
  const [posts, setPosts] = useState<ClientPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const bluesky = useRef<BlueskyClient | null>(null);
  const masto = useRef<MastodonCredentials | null>(null);
  const ready = useRef(false);
  const identityRef = useRef<Identity | null>(null);
  const followUriRef = useRef<string | null>(null); // Bluesky follow record uri
  const accPosts = useRef<ClientPost[]>([]); // accumulated for current tab
  const cursor = useRef<string | null>(null);
  // The tab, mirrored for callbacks that must not change identity when it
  // does (a `tab` dep on load used to re-run the whole page load on every tab
  // switch, racing switchTab's own fetch).
  const tabRef = useRef<Tab>("posts");
  // Bumped on every reset; a fetch that finishes after a newer reset (quick
  // tab switching, or a refresh mid-loadMore) drops its results.
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const ensureClients = useCallback(async () => {
    if (ready.current) return;
    masto.current = await getMastodonCredentials();
    bluesky.current = await BlueskyClient.create();
    ready.current = true;
  }, []);

  // Builds an Identity from a live profile lookup, for actors the user doesn't
  // follow (no DB row). Sets stats + follow state as a side effect, mirroring
  // loadProfile. Cross-references the identity map so a matched actor still
  // links to its person.
  const resolveActor = useCallback(async (platform: string, actor: string): Promise<Identity | null> => {
    const map = await getIdentityMap();
    if (platform === "bluesky" && bluesky.current) {
      const p = await bluesky.current.getProfile(actor);
      const handle = (p.handle as string) || actor;
      setStats({
        followers: (p.followersCount as number) ?? null,
        following: (p.followsCount as number) ?? null,
        posts: (p.postsCount as number) ?? null,
      });
      followUriRef.current = extractBlueskyFollowUri(p);
      setIsFollowing(!!followUriRef.current);
      return {
        id: 0,
        personId: map.byHandle.get(handle)?.personId ?? null,
        platform: "bluesky",
        handle,
        did: (p.did as string) ?? null,
        displayName: (p.displayName as string) ?? null,
        avatarUrl: (p.avatar as string) ?? null,
        bio: (p.description as string) ?? null,
        bannerUrl: (p.banner as string) ?? null,
        profileUrl: `https://bsky.app/profile/${handle}`,
      };
    }
    if (platform === "mastodon" && masto.current) {
      const acct = await lookupMastodonAccount(masto.current, actor);
      if (!acct) return null;
      const instanceHost = new URL(masto.current.instanceUrl).hostname;
      const handle = acct.acct.includes("@") ? `@${acct.acct}` : `@${acct.acct}@${instanceHost}`;
      setStats({ followers: acct.followers_count, following: acct.following_count, posts: acct.statuses_count });
      setIsFollowing(!!(await fetchMastodonRelationship(masto.current, acct.id)));
      const banner = acct.header && !acct.header.includes("missing") ? acct.header : null;
      return {
        id: 0,
        personId: map.byHandle.get(handle)?.personId ?? null,
        platform: "mastodon",
        handle,
        did: acct.id,
        displayName: acct.display_name || null,
        avatarUrl: acct.avatar || null,
        bio: acct.note || null,
        bannerUrl: banner,
        profileUrl: acct.url || null,
      };
    }
    return null;
  }, []);

  // Live profile → stats, banner, follow state.
  const loadProfile = useCallback(async (ident: Identity) => {
    if (ident.platform === "bluesky" && bluesky.current && ident.did) {
      const p = await bluesky.current.getProfile(ident.did);
      setStats({
        followers: (p.followersCount as number) ?? null,
        following: (p.followsCount as number) ?? null,
        posts: (p.postsCount as number) ?? null,
      });
      const followUri = extractBlueskyFollowUri(p);
      followUriRef.current = followUri;
      setIsFollowing(!!followUri);
    } else if (ident.platform === "mastodon" && masto.current && ident.did) {
      const [acct, following] = await Promise.all([
        fetchMastodonAccountById(masto.current, ident.did),
        fetchMastodonRelationship(masto.current, ident.did),
      ]);
      if (acct) {
        setStats({
          followers: (acct.followers_count as number) ?? null,
          following: (acct.following_count as number) ?? null,
          posts: (acct.statuses_count as number) ?? null,
        });
      }
      setIsFollowing(!!following);
    }
  }, []);

  // Fetches a page of the current tab and re-renders. reset clears accumulators.
  const fetchTabPage = useCallback(async (ident: Identity, t: Tab, reset: boolean) => {
    if (reset) {
      generation.current++;
      accPosts.current = [];
      cursor.current = null;
    } else if (cursor.current === null) {
      return; // exhausted
    }
    const gen = generation.current;

    let page: { posts: ClientPost[]; cursor: string | null } = { posts: [], cursor: null };
    if (ident.platform === "bluesky" && bluesky.current) {
      const filter =
        t === "posts" ? "posts_no_replies" :
        t === "replies" ? "posts_with_replies" : "posts_with_media";
      page = await bluesky.current.getAuthorFeed(ident.did || ident.handle, {
        filter,
        cursor: cursor.current ?? undefined,
      });
    } else if (ident.platform === "mastodon" && masto.current && ident.did) {
      page = await fetchMastodonAuthorStatuses(masto.current, ident.did, {
        maxId: cursor.current ?? undefined,
        excludeReplies: t === "posts",
        onlyMedia: t === "media" || t === "videos",
      });
    }

    if (gen !== generation.current) return; // superseded
    cursor.current = page.cursor;
    accPosts.current.push(...applyTabFilter(page.posts, t));
    const map = await getIdentityMap();
    if (gen !== generation.current) return;
    const all = [...accPosts.current];
    for (const p of all) enrichAuthor(p, map);
    all.sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    setPosts(mergeTimeline(all));
    setHasMore(page.cursor !== null);
  }, []);

  const doLoad = useCallback(async () => {
    try {
      await ensureClients();
      // identityId is either a numeric DB id (followed/matched identity) or a
      // "<platform>:<handle>" actor key (anyone — fetched live).
      let ident: Identity | null;
      let profileLoad: Promise<unknown>;
      if (/^\d+$/.test(identityId)) {
        const identRes = await fetch("/api/graph/identities");
        ident = findIdentity(await identRes.json(), parseInt(identityId));
        profileLoad = ident ? loadProfile(ident) : Promise.resolve();
      } else {
        const sep = identityId.indexOf(":");
        ident = await resolveActor(identityId.slice(0, sep), identityId.slice(sep + 1));
        profileLoad = Promise.resolve(); // resolveActor already set stats/follow
      }
      setIdentity(ident);
      identityRef.current = ident;
      if (!ident) return;
      await Promise.all([profileLoad, fetchTabPage(ident, tabRef.current, true)]);
    } catch (err) {
      console.error("Failed to load identity:", err);
    } finally {
      setLoading(false);
    }
  }, [identityId, ensureClients, loadProfile, resolveActor, fetchTabPage]);

  // Single-flight: a call while a load is running joins it instead of
  // resolving instantly, so pull-to-refresh keeps spinning until it lands.
  const load = useCallback((): Promise<void> => {
    inFlight.current ??= doLoad().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [doLoad]);

  useEffect(() => { load(); }, [load]);

  async function switchTab(t: Tab) {
    if (t === tab || !identityRef.current) return;
    tabRef.current = t;
    setTab(t);
    setPosts([]);
    await fetchTabPage(identityRef.current, t, true);
  }

  async function loadMore() {
    if (loadingMore || !hasMore || !identityRef.current) return;
    setLoadingMore(true);
    try {
      await fetchTabPage(identityRef.current, tab, false);
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggleFollow() {
    const ident = identityRef.current;
    if (!ident || followBusy) return;
    const next = !isFollowing;
    setFollowBusy(true);
    setIsFollowing(next); // optimistic
    try {
      if (ident.platform === "bluesky" && bluesky.current && ident.did) {
        if (next) {
          followUriRef.current = (await bluesky.current.follow(ident.did)).uri;
        } else if (followUriRef.current) {
          await bluesky.current.deleteRecord(followUriRef.current);
          followUriRef.current = null;
        }
      } else if (ident.platform === "mastodon" && masto.current && ident.did) {
        await mastodonFollow(masto.current, ident.did, !next);
      }
    } catch (err) {
      console.error("Follow toggle failed:", err);
      setIsFollowing(!next); // rollback
    } finally {
      setFollowBusy(false);
    }
  }

  const actions: ClientActions = {
    like: (post) => likePost(post, { bluesky: bluesky.current, mastodon: masto.current }),
    repost: (post) => repostPost(post, { bluesky: bluesky.current, mastodon: masto.current }),
  };

  return (
    <AppLayout>
      <PullToRefresh onRefresh={load} />
      <button className="back-btn" onClick={() => router.back()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back
      </button>

      {loading && <div className="spinner-container"><div className="spinner" /></div>}

      {!loading && !identity && <p className="text-muted">Identity not found.</p>}

      {!loading && identity && (
        <>
          <section className="section">
            <div className="person-identity-card">
              {identity.bannerUrl && (
                <div className="person-identity-banner" style={{ backgroundImage: `url(${identity.bannerUrl})` }} />
              )}
              <div className="person-identity-row">
                {identity.avatarUrl && (
                  <Avatar identityId={identity.id} src={identity.avatarUrl} className="person-identity-avatar" />
                )}
                <span className={`platform-badge ${identity.platform}`}>
                  {identity.platform === "bluesky" ? "B" : "M"}
                </span>
                <span className="person-identity-handle">
                  {identity.profileUrl ? (
                    <a href={identity.profileUrl} target="_blank" rel="noopener noreferrer">{identity.handle}</a>
                  ) : identity.handle}
                </span>
                <button
                  className={`btn ${isFollowing ? "btn-outline" : "btn-primary"}`}
                  onClick={toggleFollow}
                  disabled={followBusy}
                  style={{ marginLeft: "auto" }}
                >
                  {isFollowing ? "Following" : "Follow"}
                </button>
              </div>

              {stats && (
                <div className="text-muted" style={{ display: "flex", gap: 16, fontSize: "0.85em", padding: "4px 0" }}>
                  {stats.posts != null && <span><strong>{stats.posts}</strong> posts</span>}
                  {stats.following != null && <span><strong>{stats.following}</strong> following</span>}
                  {stats.followers != null && <span><strong>{stats.followers}</strong> followers</span>}
                </div>
              )}

              {identity.bio && (
                identity.platform === "mastodon" ? (
                  <div className="person-identity-bio" dangerouslySetInnerHTML={{ __html: identity.bio }} />
                ) : (
                  <p className="person-identity-bio person-identity-bio-text">{identity.bio}</p>
                )
              )}

              {identity.personId && (
                <a href={`/persons/${identity.personId}`} className="post-person-link">View person</a>
              )}
            </div>
          </section>

          <div className="identity-tabs" style={{ display: "flex", gap: 8, padding: "0 0 8px" }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`btn ${tab === t.key ? "btn-primary" : "btn-outline"}`}
                onClick={() => switchTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <section className="section">
            {posts.length === 0 && <p className="text-muted">No posts found.</p>}
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
