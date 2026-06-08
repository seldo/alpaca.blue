// Real-time Bluesky sync via Jetstream.
//
// One filtered-firehose connection for the whole app drives three things:
//   • Timeline — posts by any DID someone follows, hydrated via the public
//     AppView and fanned out to each follower (reusing mapBlueskyFeedItem +
//     storeBlueskyPosts so storage/dedup/cache match the polling path).
//   • Mentions — posts that mention / reply to / quote one of our users (detected
//     straight from the firehose record), stored as mention rows.
//   • Reactions — likes/reposts/follows whose subject is one of our users; we
//     bust their reactions cache and nudge (the app re-fetches the hydrated
//     reactions list once, rather than us rebuilding it per event).

import { db } from "@/db";
import { platformIdentities, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { storeBlueskyPosts, mapBlueskyFeedItem, type BlueskyPostData } from "@/lib/posts";
import { notifyUser } from "./sse-server";

const JETSTREAM_URL =
  process.env.JETSTREAM_URL ||
  "wss://jetstream2.us-east.bsky.network/subscribe" +
    "?wantedCollections=app.bsky.feed.post" +
    "&wantedCollections=app.bsky.feed.like" +
    "&wantedCollections=app.bsky.feed.repost" +
    "&wantedCollections=app.bsky.graph.follow";

const APPVIEW = process.env.BLUESKY_APPVIEW || "https://public.api.bsky.app";
const GETPOSTS_MAX = 25; // app.bsky.feed.getPosts caps at 25 URIs per call

const GRAPH_REFRESH_MS = 2 * 60 * 1000;
const HYDRATE_DEBOUNCE_MS = 1000;

// did -> userIds who follow that did (timeline fan-out + firehose post filter)
let didToFollowers = new Map<string, Set<number>>();
// our own users' bluesky DID -> their userId (mention/reaction targets)
let ownDidToUser = new Map<string, Set<number>>();

async function refreshGraphs(): Promise<void> {
  const followed = await db
    .select({ did: platformIdentities.did, userId: platformIdentities.userId })
    .from(platformIdentities)
    .where(and(eq(platformIdentities.platform, "bluesky"), eq(platformIdentities.isFollowed, true)));
  const nextFollowers = new Map<string, Set<number>>();
  for (const r of followed) {
    if (!r.did) continue;
    (nextFollowers.get(r.did) ?? nextFollowers.set(r.did, new Set()).get(r.did)!).add(r.userId);
  }
  didToFollowers = nextFollowers;

  const userRows = await db.select({ id: users.id, did: users.blueskyDid }).from(users);
  const nextOwn = new Map<string, Set<number>>();
  for (const u of userRows) {
    if (!u.did) continue;
    (nextOwn.get(u.did) ?? nextOwn.set(u.did, new Set()).get(u.did)!).add(u.id);
  }
  ownDidToUser = nextOwn;

  console.log(
    `[bluesky-sync] graphs: ${nextFollowers.size} followed authors, ${nextOwn.size} own DIDs`,
  );
}

function didFromAtUri(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("at://")) return null;
  return uri.split("/")[2] || null;
}

// Which of our users does this post record reference (mention facet, reply to
// their post, or quote of their post)?
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectMentionTargets(record: any): Set<number> {
  const targets = new Set<number>();
  const add = (did: string | null) => {
    if (!did) return;
    const us = ownDidToUser.get(did);
    if (us) for (const u of us) targets.add(u);
  };

  if (Array.isArray(record?.facets)) {
    for (const facet of record.facets) {
      for (const feature of facet?.features ?? []) {
        if (typeof feature?.$type === "string" && feature.$type.endsWith("#mention")) {
          add(feature.did ?? null);
        }
      }
    }
  }
  add(didFromAtUri(record?.reply?.parent?.uri));
  const embed = record?.embed;
  if (embed?.$type === "app.bsky.embed.record") add(didFromAtUri(embed.record?.uri));
  if (embed?.$type === "app.bsky.embed.recordWithMedia") add(didFromAtUri(embed.record?.record?.uri));
  return targets;
}

// ── Post hydration queue (timeline + mentions) ─────────────

interface PostTargets {
  timeline: Set<number>;
  mention: Set<number>;
}
let pendingPosts = new Map<string, PostTargets>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queuePost(uri: string, timeline: Set<number> | undefined, mention: Set<number>): void {
  let t = pendingPosts.get(uri);
  if (!t) {
    t = { timeline: new Set(), mention: new Set() };
    pendingPosts.set(uri, t);
  }
  if (timeline) for (const u of timeline) t.timeline.add(u);
  for (const u of mention) t.mention.add(u);
  if (pendingPosts.size >= GETPOSTS_MAX) void flushPending();
  else if (!flushTimer) flushTimer = setTimeout(() => void flushPending(), HYDRATE_DEBOUNCE_MS);
}

async function flushPending(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingPosts.size === 0) return;
  // Swap out the queue so events arriving during hydration accumulate cleanly.
  const batch = pendingPosts;
  pendingPosts = new Map();
  const uris = [...batch.keys()];
  for (let i = 0; i < uris.length; i += GETPOSTS_MAX) {
    const chunk = uris.slice(i, i + GETPOSTS_MAX);
    try {
      await hydrateAndStore(chunk, batch);
    } catch (err) {
      console.error("[bluesky-sync] hydrate/store error:", err);
    }
  }
}

async function hydrateAndStore(uris: string[], targetsByUri: Map<string, PostTargets>): Promise<void> {
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

  const byUser = new Map<number, { posts: BlueskyPostData[]; channels: Set<"timeline" | "mentions"> }>();
  const bucket = (uid: number) => {
    let b = byUser.get(uid);
    if (!b) {
      b = { posts: [], channels: new Set() };
      byUser.set(uid, b);
    }
    return b;
  };

  for (const view of views) {
    const targets = targetsByUri.get(view.uri);
    if (!targets) continue;
    const base = mapBlueskyFeedItem({ post: view });
    for (const uid of targets.timeline) {
      bucket(uid).posts.push({ ...base, isMention: false });
      bucket(uid).channels.add("timeline");
    }
    for (const uid of targets.mention) {
      bucket(uid).posts.push({ ...base, isMention: true });
      bucket(uid).channels.add("mentions");
    }
  }

  let stored = 0;
  for (const [uid, { posts, channels }] of byUser) {
    const r = await storeBlueskyPosts(posts, uid);
    stored += r.stored;
    if (r.stored > 0) for (const ch of channels) notifyUser(uid, ch);
  }
  if (stored > 0) {
    console.log(`[bluesky-sync] stored ${stored} row(s) across ${byUser.size} user(s)`);
  }
}

// ── Reactions (likes / reposts / follows of our users) ─────

function handleReaction(collection: string, record: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rec = record as any;
  let subjectDid: string | null = null;
  if (collection === "app.bsky.feed.like" || collection === "app.bsky.feed.repost") {
    subjectDid = didFromAtUri(rec?.subject?.uri);
  } else if (collection === "app.bsky.graph.follow") {
    subjectDid = typeof rec?.subject === "string" ? rec.subject : null;
  }
  if (!subjectDid) return;
  const targets = ownDidToUser.get(subjectDid);
  if (!targets) return;
  for (const uid of targets) notifyUser(uid, "reactions");
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commit?: { operation?: string; collection?: string; rkey?: string; record?: any };
    };
    try {
      evt = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (evt.kind !== "commit" || !evt.commit || !evt.did) return;
    const c = evt.commit;
    if (c.operation !== "create" || !c.rkey) return;

    if (c.collection === "app.bsky.feed.post") {
      const followers = didToFollowers.get(evt.did);
      const mention = detectMentionTargets(c.record);
      if ((followers && followers.size > 0) || mention.size > 0) {
        queuePost(`at://${evt.did}/app.bsky.feed.post/${c.rkey}`, followers, mention);
      }
    } else if (
      c.collection === "app.bsky.feed.like" ||
      c.collection === "app.bsky.feed.repost" ||
      c.collection === "app.bsky.graph.follow"
    ) {
      handleReaction(c.collection, c.record);
    }
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
  await refreshGraphs();
  setInterval(() => {
    refreshGraphs().catch((err) => console.error("[bluesky-sync] graph refresh error:", err));
  }, GRAPH_REFRESH_MS);
  connect();
}
