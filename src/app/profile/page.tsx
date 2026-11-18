"use client";

// The user's own posts feed, powered by the client pipeline: own Bluesky author
// feed + own Mastodon statuses, merged + deduped in the browser with cursor
// pagination. The header/bio chrome still comes from /api/accounts + /api/auth/me
// (account metadata — small, server-owned). No server posts route.

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { PullToRefresh } from "@/components/PullToRefresh";
import { BlueskyClient } from "@/lib/client/bluesky";
import { getMastodonCredentials, fetchMastodonAuthorStatuses, type MastodonCredentials } from "@/lib/client/mastodon";
import { getIdentityMap, enrichAuthor } from "@/lib/client/identities";
import { mergeTimeline } from "@/lib/client/dedup";
import { likePost, repostPost } from "@/lib/client/actions";
import { ClientActionsContext, type ClientActions } from "@/lib/client/ClientActionsContext";
import type { ClientPost } from "@/lib/client/types";
import { SafeHtml } from "@/components/SafeHtml";
import { byFeedTimeDesc } from "@/lib/client/types";

interface UserInfo {
  blueskyHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface Account {
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  bannerUrl: string | null;
  profileUrl: string | null;
}

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<ClientPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const bluesky = useRef<BlueskyClient | null>(null);
  const masto = useRef<MastodonCredentials | null>(null);
  const ready = useRef(false);
  const allPosts = useRef<ClientPost[]>([]);
  const bskyCursor = useRef<string | null | undefined>(undefined); // null = exhausted
  const mastoCursor = useRef<string | null | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      const data = res.ok ? await res.json() : [];
      setAccounts(Array.isArray(data) ? data : []);
    } catch {
      // ignore — keep whatever we already have
    }
  }, []);

  // Fetches a page of own posts from each platform and re-renders the merged
  // view. reset clears accumulators and starts from the top.
  const fetchPage = useCallback(async (reset: boolean) => {
    if (reset) {
      allPosts.current = [];
      bskyCursor.current = undefined;
      mastoCursor.current = undefined;
    }
    const tasks: Promise<void>[] = [];

    if (bluesky.current && (reset || bskyCursor.current !== null)) {
      const cursor = reset ? undefined : bskyCursor.current ?? undefined;
      tasks.push(
        bluesky.current.getAuthorFeed(bluesky.current.did, { cursor }).then((r) => {
          bskyCursor.current = r.cursor;
          allPosts.current.push(...r.posts);
        }).catch((e) => console.error("[profile] bluesky feed failed:", e)),
      );
    }
    if (masto.current?.accountId && (reset || mastoCursor.current !== null)) {
      const maxId = reset ? undefined : mastoCursor.current ?? undefined;
      const creds = masto.current;
      tasks.push(
        fetchMastodonAuthorStatuses(creds, creds.accountId!, { maxId }).then((r) => {
          mastoCursor.current = r.cursor;
          allPosts.current.push(...r.posts);
        }).catch((e) => console.error("[profile] mastodon feed failed:", e)),
      );
    }
    await Promise.all(tasks);

    const map = await getIdentityMap();
    const all = [...allPosts.current];
    for (const p of all) enrichAuthor(p, map);
    all.sort(byFeedTimeDesc);
    setPosts(mergeTimeline(all));
    setHasMore(
      (!!bluesky.current && bskyCursor.current !== null) ||
      (!!masto.current?.accountId && mastoCursor.current !== null),
    );
  }, []);

  const doRefreshPosts = useCallback(async () => {
    setFetching(true);
    try {
      if (!ready.current) {
        masto.current = await getMastodonCredentials();
        bluesky.current = await BlueskyClient.create();
        ready.current = true;
      }
      await fetchPage(true);
      await fetchAccounts();
    } catch (err) {
      console.error("Profile refresh error:", err);
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }, [fetchPage, fetchAccounts]);

  // Single-flight: a call while a load is running joins it instead of
  // resolving instantly, so pull-to-refresh keeps spinning until it lands.
  const refreshPosts = useCallback((): Promise<void> => {
    inFlight.current ??= doRefreshPosts().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [doRefreshPosts]);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then(setUser).catch(() => {});
    fetchAccounts();
    refreshPosts();
  }, [refreshPosts, fetchAccounts]);

  // Pull in the user's own post after composing.
  useEffect(() => {
    function handler() { setTimeout(refreshPosts, 1000); }
    window.addEventListener("posts:created", handler);
    return () => window.removeEventListener("posts:created", handler);
  }, [refreshPosts]);

  async function loadMore() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(false);
    } finally {
      setLoadingMore(false);
    }
  }

  const actions: ClientActions = {
    like: (post) => likePost(post, { bluesky: bluesky.current, mastodon: masto.current }),
    repost: (post) => repostPost(post, { bluesky: bluesky.current, mastodon: masto.current }),
  };

  return (
    <AppLayout>
      <PullToRefresh onRefresh={refreshPosts} />
      <button className="back-btn" onClick={() => router.back()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back
      </button>

      <ProfileHeader user={user} accounts={accounts} />
      {accounts.map((a) => a.bio ? (
        <ProfileBioBlock key={`${a.platform}-${a.handle}`} account={a} />
      ) : null)}

      {(loading || fetching) && (
        <div className="spinner-container"><div className="spinner" /></div>
      )}

      {!loading && posts.length === 0 && !fetching && (
        <p className="text-muted" style={{ textAlign: "center", padding: "40px 0" }}>
          No posts yet.
        </p>
      )}

      {!loading && (
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
      )}
    </AppLayout>
  );
}

// Picks the Bluesky banner if present (it's the login platform); falls back
// to Mastodon's. The banner is purely decorative — alt text is intentional
// and empty so screen readers skip it.
function ProfileHeader({ user, accounts }: { user: UserInfo | null; accounts: Account[] }) {
  const banner =
    accounts.find((a) => a.platform === "bluesky")?.bannerUrl ??
    accounts.find((a) => a.platform === "mastodon")?.bannerUrl ??
    null;

  return (
    <div className="profile-header-container">
      {banner ? (
        <div className="profile-banner" style={{ backgroundImage: `url(${banner})` }} />
      ) : (
        <div className="profile-banner profile-banner-empty" />
      )}
      <div className="profile-header">
        {user?.avatarUrl && (
          <img src={user.avatarUrl} alt="" className="profile-avatar" />
        )}
        <div className="profile-info">
          <h1 className="profile-displayname">{user?.displayName || user?.blueskyHandle}</h1>
          <div className="profile-accounts">
            {accounts.map((a) => (
              <span key={`${a.platform}-${a.handle}`} className="profile-account-chip">
                <span className={`platform-badge ${a.platform}`}>
                  {a.platform === "bluesky" ? "B" : "M"}
                </span>
                <span className="profile-account-handle">{a.handle}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Mastodon bios arrive as HTML (links, mentions); Bluesky bios are plain text
// with newlines. Render each accordingly so links keep working on Mastodon
// and line breaks are preserved on Bluesky.
function ProfileBioBlock({ account }: { account: Account }) {
  if (!account.bio) return null;
  return (
    <section className="profile-bio">
      <div className="profile-bio-header">
        <span className={`platform-badge ${account.platform}`}>
          {account.platform === "bluesky" ? "B" : "M"}
        </span>
        <span className="profile-bio-handle">{account.handle}</span>
      </div>
      {account.platform === "mastodon" ? (
        <SafeHtml
          className="profile-bio-content"
          html={account.bio}
        />
      ) : (
        <p className="profile-bio-content profile-bio-content-text">{account.bio}</p>
      )}
    </section>
  );
}
