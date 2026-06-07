// Real-time Bluesky timeline sync via Jetstream.
//
// Instead of every user polling getTimeline on a timer, we hold a single
// Jetstream (filtered firehose) connection for the whole app, watch for new
// posts authored by any DID someone follows, hydrate them through the public
// AppView, and fan each post out to every follower's stored timeline — reusing
// the exact same mapping/storage the polling path uses (mapBlueskyFeedItem +
// storeBlueskyPosts), so dedup, cache-busting, and the per-user row model all
// behave identically.

import { db } from "@/db";
import { platformIdentities } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { storeBlueskyPosts, mapBlueskyFeedItem, type BlueskyPostData } from "@/lib/posts";
import { notifyUser } from "./sse-server";

const JETSTREAM_URL =
  process.env.JETSTREAM_URL ||
  "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";
// Public AppView — unauthenticated reads, lets us hydrate raw firehose URIs into
// fully-rendered post views without any per-user credentials.
const APPVIEW = process.env.BLUESKY_APPVIEW || "https://public.api.bsky.app";
const GETPOSTS_MAX = 25; // app.bsky.feed.getPosts caps at 25 URIs per call

const FOLLOW_REFRESH_MS = 2 * 60 * 1000; // rebuild the follow graph every 2 min
const HYDRATE_DEBOUNCE_MS = 1000; // batch incoming URIs for up to 1s
const HYDRATE_MAX_BATCH = GETPOSTS_MAX;

// did -> set of userIds who follow that did. The keys double as the in-process
// filter for the firehose.
let didToUserIds = new Map<string, Set<number>>();

async function refreshFollowGraph(): Promise<void> {
  const rows = await db
    .select({ did: platformIdentities.did, userId: platformIdentities.userId })
    .from(platformIdentities)
    .where(
      and(
        eq(platformIdentities.platform, "bluesky"),
        eq(platformIdentities.isFollowed, true),
      ),
    );
  const next = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!r.did) continue;
    let set = next.get(r.did);
    if (!set) {
      set = new Set();
      next.set(r.did, set);
    }
    set.add(r.userId);
  }
  didToUserIds = next;
  console.log(`[bluesky-sync] follow graph: ${next.size} distinct authors followed`);
}

// ── Hydration queue ────────────────────────────────────────
// Firehose events arrive one post at a time; we batch the URIs and hydrate them
// in getPosts-sized chunks to keep AppView calls minimal.

const pendingUris = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueUri(uri: string): void {
  pendingUris.add(uri);
  if (pendingUris.size >= HYDRATE_MAX_BATCH) {
    void flushPending();
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(() => void flushPending(), HYDRATE_DEBOUNCE_MS);
}

async function flushPending(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingUris.size === 0) return;
  const uris = [...pendingUris];
  pendingUris.clear();
  for (let i = 0; i < uris.length; i += GETPOSTS_MAX) {
    const chunk = uris.slice(i, i + GETPOSTS_MAX);
    try {
      await hydrateAndStore(chunk);
    } catch (err) {
      console.error("[bluesky-sync] hydrate/store error:", err);
    }
  }
}

async function hydrateAndStore(uris: string[]): Promise<void> {
  const qs = uris.map((u) => `uris=${encodeURIComponent(u)}`).join("&");
  const res = await fetch(`${APPVIEW}/xrpc/app.bsky.feed.getPosts?${qs}`);
  if (!res.ok) {
    console.warn(`[bluesky-sync] getPosts ${res.status}`);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as { posts?: any[] };
  const views = data.posts || [];
  if (views.length === 0) return;

  // Fan out: one storeBlueskyPosts call per affected user, carrying every post
  // in this batch authored by someone that user follows.
  const byUser = new Map<number, BlueskyPostData[]>();
  for (const view of views) {
    const authorDid: string | undefined = view?.author?.did;
    const followers = authorDid ? didToUserIds.get(authorDid) : undefined;
    if (!followers || followers.size === 0) continue;
    const mapped = mapBlueskyFeedItem({ post: view });
    for (const userId of followers) {
      let arr = byUser.get(userId);
      if (!arr) {
        arr = [];
        byUser.set(userId, arr);
      }
      arr.push(mapped);
    }
  }

  let stored = 0;
  for (const [userId, postsForUser] of byUser) {
    const r = await storeBlueskyPosts(postsForUser, userId);
    stored += r.stored;
    if (r.stored > 0) notifyUser(userId);
  }
  if (stored > 0) {
    console.log(
      `[bluesky-sync] stored ${stored} row(s) across ${byUser.size} user(s) from ${views.length} post(s)`,
    );
  }
}

// ── Jetstream connection (auto-reconnect) ──────────────────

let ws: WebSocket | null = null;
let backoffMs = 1000;

function connect(): void {
  console.log("[bluesky-sync] connecting to Jetstream…");
  ws = new WebSocket(JETSTREAM_URL);

  ws.onopen = () => {
    backoffMs = 1000;
    console.log("[bluesky-sync] Jetstream connected");
  };

  ws.onmessage = (event: MessageEvent) => {
    let evt: {
      kind?: string;
      did?: string;
      commit?: { operation?: string; collection?: string; rkey?: string };
    };
    try {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    if (evt.kind !== "commit" || !evt.commit || !evt.did) return;
    const c = evt.commit;
    if (c.operation !== "create" || c.collection !== "app.bsky.feed.post" || !c.rkey) return;
    if (!didToUserIds.has(evt.did)) return; // nobody here follows this author
    queueUri(`at://${evt.did}/app.bsky.feed.post/${c.rkey}`);
  };

  ws.onerror = (event: Event) => {
    console.error("[bluesky-sync] Jetstream error:", (event as ErrorEvent).message || event.type);
  };

  ws.onclose = () => {
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, 30000);
    console.warn(`[bluesky-sync] Jetstream closed; reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  };
}

export async function startBlueskySync(): Promise<void> {
  await refreshFollowGraph();
  setInterval(() => {
    refreshFollowGraph().catch((err) =>
      console.error("[bluesky-sync] follow-graph refresh error:", err),
    );
  }, FOLLOW_REFRESH_MS);
  connect();
}
