"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientPost } from "./types";
import { getMastodonCredentials, type MastodonCredentials } from "./mastodon";
import { BlueskyClient } from "./bluesky";
import { putPosts, getRecent, type Feed } from "./store";
import { mergeTimeline } from "./dedup";
import { likePost, repostPost } from "./actions";
import { getIdentityMap, enrichAuthor } from "./identities";
import type { ClientActions } from "./ClientActionsContext";
import { feedTime } from "./types";

export interface FeedClients {
  bluesky: BlueskyClient | null;
  mastodon: MastodonCredentials | null;
}

// Generic client feed used by mentions + profile (and anything else that's just
// "fetch posts from both platforms → store → merge → render"). The home
// timeline keeps its own hook because it adds WSS streaming and a reply filter;
// this one optionally polls. New arrivals are stashed behind the "N new" pill.
export function useClientFeed<E = undefined>(opts: {
  feed: Feed;
  fetchPosts: (clients: FeedClients) => Promise<ClientPost[]>;
  // Optional non-post data fetched alongside posts (e.g. mention reactions).
  // Refreshed in place on every load; not stored or stashed behind the pill.
  fetchExtra?: (clients: FeedClients) => Promise<E>;
  pollMs?: number;
}) {
  const { feed, fetchPosts, fetchExtra, pollMs } = opts;
  const [posts, setPosts] = useState<ClientPost[]>([]);
  const [extra, setExtra] = useState<E | undefined>(undefined);
  const [newCount, setNewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const bluesky = useRef<BlueskyClient | null>(null);
  const masto = useRef<MastodonCredentials | null>(null);
  const postsRef = useRef<ClientPost[]>([]);
  const pendingRef = useRef<ClientPost[] | null>(null);
  const inFlight = useRef<{ promise: Promise<void>; stash: boolean } | null>(null);

  const mergedFromStore = useCallback(async () => {
    const [all, map] = await Promise.all([getRecent(300, null, feed), getIdentityMap()]);
    for (const p of all) enrichAuthor(p, map);
    return mergeTimeline(all);
  }, [feed]);

  const present = useCallback((merged: ClientPost[]) => {
    postsRef.current = merged;
    pendingRef.current = null;
    setPosts(merged);
    setNewCount(0);
  }, []);

  const stash = useCallback((merged: ClientPost[]) => {
    if (postsRef.current.length === 0) return present(merged);
    const shown = new Set(postsRef.current.map((p) => `${p.platform}:${p.platformPostId}`));
    const top = postsRef.current[0] ? feedTime(postsRef.current[0]) : undefined;
    const fresh = merged.filter(
      (p) => !shown.has(`${p.platform}:${p.platformPostId}`) && (!top || feedTime(p) > top),
    );
    if (fresh.length > 0) {
      pendingRef.current = merged;
      setNewCount(fresh.length);
    }
  }, [present]);

  // Memoized on a ref so `load` keeps a stable identity (depending on `ready`
  // used to change `load` mid-fetch and re-run the mount effect → double load).
  const clientsPromise = useRef<Promise<void> | null>(null);
  const ensureClients = useCallback(() => {
    clientsPromise.current ??= (async () => {
      masto.current = await getMastodonCredentials();
      bluesky.current = await BlueskyClient.create();
      setReady(true);
    })().catch((err) => {
      clientsPromise.current = null;
      throw err;
    });
    return clientsPromise.current;
  }, []);

  const run = useCallback(async (stashMode: boolean) => {
    if (!stashMode) setFetching(true);
    setError(null);
    try {
      await ensureClients();
      const clients = { bluesky: bluesky.current, mastodon: masto.current };
      const [fetched, extraVal] = await Promise.all([
        fetchPosts(clients),
        fetchExtra
          ? fetchExtra(clients).catch((e) => {
              console.error(`[client-feed:${feed}] extra fetch failed:`, e);
              return undefined;
            })
          : Promise.resolve(undefined),
      ]);
      await putPosts(fetched, feed);
      if (fetchExtra && extraVal !== undefined) setExtra(extraVal as E);
      const merged = await mergedFromStore();
      if (stashMode) stash(merged);
      else present(merged);
    } catch (err) {
      console.error(`[client-feed:${feed}] error:`, err);
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }, [ensureClients, fetchPosts, fetchExtra, feed, mergedFromStore, present, stash]);

  // Single-flight. A call while a load is running joins it rather than
  // returning instantly, except that a foreground (present) load requested
  // during a background (stash) poll waits for the poll and then runs, so a
  // pull-to-refresh always ends with fresh posts on screen, not behind the pill.
  const load = useCallback((stashMode: boolean): Promise<void> => {
    const cur = inFlight.current;
    if (cur) {
      if (stashMode || !cur.stash) return cur.promise;
      return cur.promise.then(() => load(false));
    }
    const promise = run(stashMode).finally(() => {
      if (inFlight.current?.promise === promise) inFlight.current = null;
    });
    inFlight.current = { promise, stash: stashMode };
    return promise;
  }, [run]);

  const refresh = useCallback(() => load(false), [load]);
  const showNew = useCallback(() => {
    if (pendingRef.current) present(pendingRef.current);
  }, [present]);

  // Instant paint from the store, then load from the network.
  useEffect(() => {
    mergedFromStore()
      .then((m) => { if (m.length > 0) present(m); })
      .catch(() => {})
      .finally(() => { setLoading(false); load(false); });
  }, [mergedFromStore, present, load]);

  // Optional polling (stash new arrivals behind the pill).
  useEffect(() => {
    if (!pollMs || !ready) return;
    const t = setInterval(() => { if (!document.hidden) load(true); }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, ready, load]);

  // Own post created (compose) → pull it in.
  useEffect(() => {
    function handler() { setTimeout(() => load(true), 1000); }
    window.addEventListener("posts:created", handler);
    return () => window.removeEventListener("posts:created", handler);
  }, [load]);

  const actions = useMemo<ClientActions | null>(() => {
    if (!ready) return null;
    const clients = () => ({ bluesky: bluesky.current, mastodon: masto.current });
    return {
      like: (post) => likePost(post, clients()),
      repost: (post) => repostPost(post, clients()),
    };
  }, [ready]);

  return { posts, extra, newCount, loading, fetching, error, refresh, showNew, actions };
}
