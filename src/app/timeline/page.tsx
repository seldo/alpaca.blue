"use client";

// Home timeline, powered entirely by the client pipeline: Bluesky (direct PDS
// via brokered DPoP) + Mastodon, fetched, deduped, and merged in the browser,
// with Mastodon WSS streaming + Bluesky polling for realtime. No /api/timeline,
// no server fetch, no worker.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { useClientTimeline } from "@/lib/client/useClientTimeline";
import { ClientActionsContext } from "@/lib/client/ClientActionsContext";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";

export default function TimelinePage() {
  const router = useRouter();
  const { posts, newCount, loading, fetching, error, refresh, showNew, actions } = useClientTimeline();

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refresh, fetching);

  // Compose success and bottom-nav tap-on-active-tab both ask the feed to reload.
  useEffect(() => {
    function onCreated() { setTimeout(refresh, 1000); }
    function onRefresh() { refresh(); }
    window.addEventListener("posts:created", onCreated);
    window.addEventListener("feed:refresh", onRefresh);
    return () => {
      window.removeEventListener("posts:created", onCreated);
      window.removeEventListener("feed:refresh", onRefresh);
    };
  }, [refresh]);

  // No posts and nothing connected → send the user to onboarding (matches the
  // previous server-backed behaviour).
  useEffect(() => {
    if (!loading && posts.length === 0) router.replace("/settings");
  }, [loading, posts.length, router]);

  return (
    <AppLayout>
      <button
        className="create-post-trigger"
        onClick={() => window.dispatchEvent(new CustomEvent("compose:open"))}
      >
        What&apos;s up?
      </button>

      {(pullDistance > 0 || pullRefreshing) && (
        <div className="pull-indicator" style={{ height: pullRefreshing ? 48 : pullDistance * 0.5 }}>
          <div className="spinner" style={{ opacity: pullRefreshing ? 1 : pullDistance > 0 ? 0.4 + 0.6 * (pullDistance / 72) : 0 }} />
        </div>
      )}

      {newCount > 0 && (
        <div className="new-posts-pill-wrap">
          <button className="new-posts-pill" onClick={showNew}>
            ↑ {newCount} new {newCount === 1 ? "post" : "posts"}
          </button>
        </div>
      )}

      {fetching && (
        <p className="text-muted" style={{ textAlign: "center", padding: "4px 0", fontSize: "0.85em" }}>Fetching posts...</p>
      )}

      {error && (
        <p className="text-muted" style={{ textAlign: "center", padding: "8px 0", color: "var(--color-error, #c0392b)" }}>
          {error}
        </p>
      )}

      {loading && <div className="spinner-container"><div className="spinner" /></div>}

      {!loading && (
        <ClientActionsContext.Provider value={actions}>
          <div className="timeline-feed">
            {posts.map((post) => (
              <PostCard key={`${post.platform}-${post.platformPostId}`} post={post} />
            ))}
          </div>
        </ClientActionsContext.Provider>
      )}
    </AppLayout>
  );
}
