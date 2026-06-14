"use client";

// Mentions feed, powered by the client pipeline: Bluesky notifications
// (mention/reply/quote, hydrated) + Mastodon @-mentions, interleaved with
// reaction notifications (likes / reposts / follows), merged and deduped in the
// browser, polled every 30s. No server fetch, no worker.

import { useCallback, useEffect, useMemo } from "react";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { useClientFeed, type FeedClients } from "@/lib/client/useClientFeed";
import { fetchMastodonMentions, fetchMastodonReactions } from "@/lib/client/mastodon";
import { getIdentityMap, enrichReactor } from "@/lib/client/identities";
import { ClientActionsContext } from "@/lib/client/ClientActionsContext";
import { PostCard } from "@/components/PostCard";
import { ReactionCard } from "@/components/ReactionCard";
import { AppLayout } from "@/components/AppHeader";
import { groupReactions, type RawReaction, type ReactionGroup } from "@/lib/reactions";
import type { ClientPost } from "@/lib/client/types";

async function settle<T>(promises: Promise<T[]>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const out: T[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.error("[mentions] fetch failed:", r.reason);
  }
  return out;
}

export default function MentionsPage() {
  const fetchPosts = useCallback(
    (c: FeedClients) =>
      settle<ClientPost>([
        c.bluesky ? c.bluesky.getMentions() : Promise.resolve([]),
        c.mastodon ? fetchMastodonMentions(c.mastodon) : Promise.resolve([]),
      ]),
    [],
  );

  const fetchExtra = useCallback(async (c: FeedClients): Promise<ReactionGroup[]> => {
    const [raw, map] = await Promise.all([
      settle<RawReaction>([
        c.bluesky ? c.bluesky.getReactions() : Promise.resolve([]),
        c.mastodon ? fetchMastodonReactions(c.mastodon) : Promise.resolve([]),
      ]),
      getIdentityMap(),
    ]);
    // Link reactors to their in-app identity/person so ReactionCard deep-links.
    for (const r of raw) enrichReactor(r.reactor, map);
    return groupReactions(raw);
  }, []);

  const { posts, extra: reactionGroups, newCount, loading, fetching, error, refresh, showNew, actions } =
    useClientFeed<ReactionGroup[]>({ feed: "mentions", fetchPosts, fetchExtra, pollMs: 30_000 });

  // Interleave mention posts + reaction groups by time, newest first.
  const items = useMemo(() => {
    type FeedItem =
      | { sortKey: string; kind: "post"; data: ClientPost }
      | { sortKey: string; kind: "reaction"; data: ReactionGroup };
    const arr: FeedItem[] = [
      ...posts.map((p) => ({ sortKey: p.postedAt, kind: "post" as const, data: p })),
      ...(reactionGroups ?? []).map((g) => ({ sortKey: g.latestAt, kind: "reaction" as const, data: g })),
    ];
    return arr.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [posts, reactionGroups]);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refresh, fetching);

  // Bottom-nav tap-on-active-tab reloads.
  useEffect(() => {
    function onRefresh() { refresh(); }
    window.addEventListener("feed:refresh", onRefresh);
    return () => window.removeEventListener("feed:refresh", onRefresh);
  }, [refresh]);

  return (
    <AppLayout>
      {(pullDistance > 0 || pullRefreshing) && (
        <div className="pull-indicator" style={{ height: pullRefreshing ? 48 : pullDistance * 0.5 }}>
          <div className="spinner" style={{ opacity: pullRefreshing ? 1 : pullDistance > 0 ? 0.4 + 0.6 * (pullDistance / 72) : 0 }} />
        </div>
      )}

      {newCount > 0 && (
        <div className="new-posts-pill-wrap">
          <button className="new-posts-pill" onClick={showNew}>
            ↑ {newCount} new {newCount === 1 ? "mention" : "mentions"}
          </button>
        </div>
      )}

      {fetching && (
        <p className="text-muted" style={{ textAlign: "center", padding: "4px 0", fontSize: "0.85em" }}>Fetching mentions...</p>
      )}

      {error && (
        <p className="text-muted" style={{ textAlign: "center", padding: "8px 0", color: "var(--color-error, #c0392b)" }}>
          {error}
        </p>
      )}

      {loading && <div className="spinner-container"><div className="spinner" /></div>}

      {!loading && items.length === 0 && (
        <p className="text-muted" style={{ textAlign: "center", padding: "24px 0" }}>No mentions or reactions yet.</p>
      )}

      {!loading && (
        <ClientActionsContext.Provider value={actions}>
          <div className="timeline-feed">
            {items.map((item) =>
              item.kind === "reaction" ? (
                <ReactionCard key={item.data.id} group={item.data} />
              ) : (
                <PostCard key={`${item.data.platform}-${item.data.platformPostId}`} post={item.data} />
              ),
            )}
          </div>
        </ClientActionsContext.Provider>
      )}
    </AppLayout>
  );
}
