"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { usePullToRefresh } from "@/lib/usePullToRefresh";

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
    uri: string; authorHandle: string; authorDisplayName?: string;
    authorAvatar?: string; text: string;
    media?: Array<{ type: string; url: string; alt: string }>; postedAt?: string;
  } | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: { id: number; handle: string; displayName: string | null; avatarUrl: string | null; platform: string; profileUrl: string | null } | null;
  person: { id: number; displayName: string | null } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null; platformPostId: string; platformPostCid: string | null; threadRootId: string | null; threadRootCid: string | null }>;
  replyToAuthor: { handle: string; dbPostId: number; postUrl: string | null } | null;
}

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetching, setFetching] = useState(false);
  const isFetchingRef = useRef(false);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      const data = res.ok ? await res.json() : [];
      setAccounts(Array.isArray(data) ? data : []);
    } catch {
      // ignore — keep whatever we already have
    }
  }, []);

  const refreshPosts = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setFetching(true);

    try {
      const res = await fetch("/api/profile/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        setPosts(data.posts);
        setNextCursor(data.nextCursor);
      }
      // /api/profile/posts refreshes the user's own bio + banner data
      // server-side. Refetch /api/accounts so the header reflects it.
      await fetchAccounts();
    } catch (err) {
      console.error("Profile refresh error:", err);
    } finally {
      setFetching(false);
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [fetchAccounts]);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then(setUser).catch(() => {});
    fetchAccounts();
    refreshPosts();
  }, [refreshPosts, fetchAccounts]);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refreshPosts, fetching);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/profile/posts?cursor=${nextCursor}&limit=50`);
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
        <div
          className="profile-bio-content"
          dangerouslySetInnerHTML={{ __html: account.bio }}
        />
      ) : (
        <p className="profile-bio-content profile-bio-content-text">{account.bio}</p>
      )}
    </section>
  );
}
