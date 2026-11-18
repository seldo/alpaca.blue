// IndexedDB-backed post store — the client analogue of the server `posts` table
// + Redis timeline cache. Holds the merged/raw posts so feeds paint instantly on
// cold load and survive reloads. Raw IndexedDB (no dependency); a thin promise
// wrapper is enough for our access pattern.
//
// Each feed (timeline / mentions / profile) gets its own object store so the
// same post appearing in two feeds can't clobber the other's view. This avoids
// the OR-merge the server does on its isTimeline/isMention flags.

import type { ClientPost } from "./types";
import { storeKey, feedTime } from "./types";

// One database per user. The cache used to be a single global "alpaca" DB,
// so a second account on the same browser saw (and kept seeing, mixed into
// its own feeds) the previous account's timeline and mentions.
const LEGACY_DB_NAME = "alpaca";
const DB_VERSION = 2;

export type Feed = "timeline" | "mentions" | "profile";

// Feed → object-store name. "timeline" keeps the original "posts" name.
const STORE: Record<Feed, string> = {
  timeline: "posts",
  mentions: "mentions",
  profile: "profile",
};

interface PostRecord {
  key: string; // `${platform}:${platformPostId}`
  // Indexed feed position (ISO; sorts lexicographically by time). This is the
  // repost time for a repost, so reposts sort where they happened.
  postedAt: string;
  post: ClientPost;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let legacyDropped = false;

// The signed-in user's id. Not cached across failures, so a transient error
// doesn't leave the session without a store.
let userIdPromise: Promise<number> | null = null;
let knownUserId: number | null = null; // survives logout, for clearLocalPosts
function currentUserId(): Promise<number> {
  userIdPromise ??= fetch("/api/auth/me")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`auth/me ${r.status}`))))
    .then((me: { id?: number }) => {
      if (typeof me.id !== "number") throw new Error("auth/me returned no id");
      knownUserId = me.id;
      return me.id;
    })
    .catch((err) => {
      userIdPromise = null;
      throw err;
    });
  return userIdPromise;
}

function dbNameFor(userId: number): string {
  return `alpaca-user-${userId}`;
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (!legacyDropped) {
    legacyDropped = true;
    try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch { /* ignore */ }
  }
  dbPromise = currentUserId().then(
    (userId) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbNameFor(userId), DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const name of Object.values(STORE)) {
            if (!db.objectStoreNames.contains(name)) {
              const os = db.createObjectStore(name, { keyPath: "key" });
              os.createIndex("postedAt", "postedAt");
            }
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // Let another tab's clearLocalPosts() delete the DB instead of
          // being blocked by this open connection.
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// Deletes the signed-in user's cached posts (logout, account disconnect,
// reset). Safe to call when nothing is cached.
export async function clearLocalPosts(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  try {
    const db = await open;
    db?.close();
  } catch { /* ignore */ }
  let userId = knownUserId;
  if (userId === null) {
    try { userId = await currentUserId(); } catch { /* logged out already */ }
  }
  userIdPromise = null;
  knownUserId = null;
  const names = [LEGACY_DB_NAME, ...(userId !== null ? [dbNameFor(userId)] : [])];
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
}

// `incoming` wins for content/counts/viewer state; the repost fields come from
// whichever copy has the newer feed position.
function keepNewestPosition(incoming: ClientPost, other: ClientPost): ClientPost {
  if (feedTime(other) <= feedTime(incoming)) return incoming;
  return {
    ...incoming,
    repostOfId: other.repostOfId,
    repostedBy: other.repostedBy ?? null,
    repostedAt: other.repostedAt ?? null,
  };
}

// Upserts posts by their stable `${platform}:${platformPostId}` key. The
// incoming copy wins for content/counts/viewer state, but the feed position
// is the newest one seen: the original and a repost of it share a key, and
// whichever arrives last must not drop a newer repost (or its "reposted by")
// back to the original's older position.
export async function putPosts(posts: ClientPost[], feed: Feed = "timeline"): Promise<void> {
  if (posts.length === 0) return;
  // Collapse duplicates within this batch first. (All the gets below are
  // queued before any put runs, so a later duplicate wouldn't see an earlier
  // one's put.)
  const byKey = new Map<string, ClientPost>();
  for (const post of posts) {
    const key = storeKey(post.platform, post.platformPostId);
    const prev = byKey.get(key);
    byKey.set(key, prev ? keepNewestPosition(post, prev) : post);
  }
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE[feed], "readwrite");
    const os = transaction.objectStore(STORE[feed]);
    for (const [key, post] of byKey) {
      const getReq = os.get(key);
      getReq.onsuccess = () => {
        const existing = (getReq.result as PostRecord | undefined)?.post;
        const merged = existing ? keepNewestPosition(post, existing) : post;
        const record: PostRecord = { key, postedAt: feedTime(merged), post: merged };
        os.put(record);
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Merges `partial` into a stored post (e.g. viewerLiked / likeCount after a
// reaction) so the optimistic UI survives a reload. No-op if the post isn't in
// the given feed's store.
export async function patchPost(
  key: string,
  partial: Partial<ClientPost>,
  feed: Feed = "timeline",
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE[feed], "readwrite");
    const os = transaction.objectStore(STORE[feed]);
    const getReq = os.get(key);
    getReq.onsuccess = () => {
      const rec = getReq.result as PostRecord | undefined;
      if (rec) os.put({ ...rec, post: { ...rec.post, ...partial } });
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Returns the most recent `limit` posts in a feed, newest first. Optional
// `before` cursor (ISO timestamp) returns posts strictly older than it.
export async function getRecent(
  limit: number,
  before?: string | null,
  feed: Feed = "timeline",
): Promise<ClientPost[]> {
  const db = await openDB();
  return new Promise<ClientPost[]>((resolve, reject) => {
    const index = db.transaction(STORE[feed], "readonly").objectStore(STORE[feed]).index("postedAt");
    const range = before ? IDBKeyRange.upperBound(before, true) : undefined;
    const out: ClientPost[] = [];
    const cursorReq = index.openCursor(range, "prev"); // descending by postedAt
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push((cursor.value as PostRecord).post);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}
