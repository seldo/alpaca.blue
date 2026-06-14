"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientPost } from "./types";
import { getMastodonCredentials, fetchMastodonHomeTimeline, type MastodonCredentials } from "./mastodon";
import { mapMastodonStatus, type MastodonStatus } from "./transform";
import { BlueskyClient } from "./bluesky";
import { putPosts, getRecent } from "./store";
import { mergeTimeline, attachDedupeHashes } from "./dedup";
import { startRealtime } from "./realtime";
import { likePost, repostPost } from "./actions";
import { getIdentityMap, enrichAuthor } from "./identities";
import type { ClientActions } from "./ClientActionsContext";

// Orchestrates the client-side timeline pipeline (Phase 3: Bluesky + Mastodon +
// realtime). Initial load and manual refresh present immediately; realtime
// arrivals (Mastodon WSS push, Bluesky poll) are stashed behind an "N new posts"
// pill so the feed never jumps under the reader — matching the production
// /timeline UX.
export function useClientTimeline() {
  const [posts, setPosts] = useState<ClientPost[]>([]);
  const [newCount, setNewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // clients resolved → safe to start realtime

  const mastoCreds = useRef<MastodonCredentials | null>(null);
  const bluesky = useRef<BlueskyClient | null>(null);
  const postsRef = useRef<ClientPost[]>([]); // currently displayed (stale-closure-free)
  const pendingRef = useRef<ClientPost[] | null>(null); // merged but not yet shown
  const inFlight = useRef(false);

  // Reads everything local and produces the merged timeline view (replies
  // excluded, matching the server's queryTimeline; reposts kept).
  const mergedFromStore = useCallback(async (): Promise<ClientPost[]> => {
    const [all, map] = await Promise.all([getRecent(300), getIdentityMap()]);
    const timelineOnly = all.filter((p) => !p.replyToId);
    // Enrich before merge so cross-platform posts by the same person collapse.
    for (const p of timelineOnly) enrichAuthor(p, map);
    return mergeTimeline(timelineOnly);
  }, []);

  // Show `merged` now and clear any pending pill.
  const present = useCallback((merged: ClientPost[]) => {
    postsRef.current = merged;
    pendingRef.current = null;
    setPosts(merged);
    setNewCount(0);
  }, []);

  // Stash `merged` behind the pill when it contains posts newer than the top of
  // what's on screen; otherwise drop it (nothing genuinely new to surface).
  const stash = useCallback((merged: ClientPost[]) => {
    if (postsRef.current.length === 0) return present(merged);
    const shownKeys = new Set(postsRef.current.map((p) => `${p.platform}:${p.platformPostId}`));
    const top = postsRef.current[0]?.postedAt;
    const fresh = merged.filter(
      (p) => !shownKeys.has(`${p.platform}:${p.platformPostId}`) && (!top || p.postedAt > top),
    );
    if (fresh.length > 0) {
      pendingRef.current = merged;
      setNewCount(fresh.length);
    }
  }, [present]);

  // Lazily resolve credentials + clients once, reused across the session.
  const ensureClients = useCallback(async () => {
    if (!ready) {
      mastoCreds.current = await getMastodonCredentials();
      bluesky.current = await BlueskyClient.create();
      setReady(true);
    }
  }, [ready]);

  // Manual / initial refresh: fetch both platforms and present immediately.
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFetching(true);
    setError(null);
    try {
      await ensureClients();
      const results = await Promise.allSettled([
        bluesky.current ? bluesky.current.getTimeline() : Promise.resolve<ClientPost[]>([]),
        mastoCreds.current ? fetchMastodonHomeTimeline(mastoCreds.current) : Promise.resolve<ClientPost[]>([]),
      ]);
      const fetched: ClientPost[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") fetched.push(...r.value);
        else console.error("[client-timeline] platform fetch failed:", r.reason);
      }
      if (fetched.length === 0 && results.every((r) => r.status === "rejected")) {
        setError("Failed to load timeline from both platforms.");
      } else {
        await putPosts(fetched);
        present(await mergedFromStore());
      }
    } catch (err) {
      console.error("[client-timeline] refresh error:", err);
      setError(err instanceof Error ? err.message : "Failed to load timeline");
    } finally {
      setFetching(false);
      setLoading(false);
      inFlight.current = false;
    }
  }, [ensureClients, mergedFromStore, present]);

  // Realtime ingest: store new posts, then stash behind the pill.
  const ingestMastodon = useCallback(async (statuses: MastodonStatus[]) => {
    const creds = mastoCreds.current;
    if (!creds) return;
    const host = new URL(creds.instanceUrl).hostname;
    const mapped = await attachDedupeHashes(statuses.map((s) => mapMastodonStatus(s, host)));
    await putPosts(mapped);
    stash(await mergedFromStore());
  }, [mergedFromStore, stash]);

  const pollBluesky = useCallback(async () => {
    if (!bluesky.current) return;
    try {
      await putPosts(await bluesky.current.getTimeline());
      stash(await mergedFromStore());
    } catch (err) {
      console.error("[client-timeline] bluesky poll failed:", err);
    }
  }, [mergedFromStore, stash]);

  const showNew = useCallback(() => {
    if (pendingRef.current) present(pendingRef.current);
  }, [present]);

  // Write actions for PostCard (via ClientActionsContext). Stable across renders
  // once clients are resolved; reads the live client refs at call time.
  const actions = useMemo<ClientActions | null>(() => {
    if (!ready) return null;
    const clients = () => ({ bluesky: bluesky.current, mastodon: mastoCreds.current });
    return {
      like: (post) => likePost(post, clients()),
      repost: (post) => repostPost(post, clients()),
    };
  }, [ready]);

  // Instant paint from IndexedDB, then refresh from the network.
  useEffect(() => {
    mergedFromStore()
      .then((merged) => { if (merged.length > 0) present(merged); })
      .catch(() => {})
      .finally(() => { setLoading(false); refresh(); });
  }, [mergedFromStore, present, refresh]);

  // Start realtime once clients are resolved.
  useEffect(() => {
    if (!ready) return;
    const stop = startRealtime({
      mastodon: mastoCreds.current,
      bluesky: bluesky.current,
      onMastodonStatuses: ingestMastodon,
      onBlueskyTick: pollBluesky,
    });
    return stop;
  }, [ready, ingestMastodon, pollBluesky]);

  return { posts, newCount, loading, fetching, error, refresh, showNew, actions };
}
