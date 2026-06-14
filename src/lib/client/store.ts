// IndexedDB-backed post store — the client analogue of the server `posts` table
// + Redis timeline cache. Holds the merged/raw posts so feeds paint instantly on
// cold load and survive reloads. Raw IndexedDB (no dependency); a thin promise
// wrapper is enough for our access pattern.
//
// Each feed (timeline / mentions / profile) gets its own object store so the
// same post appearing in two feeds can't clobber the other's view. This avoids
// the OR-merge the server does on its isTimeline/isMention flags.

import type { ClientPost } from "./types";
import { storeKey } from "./types";

const DB_NAME = "alpaca";
const DB_VERSION = 2;

export type Feed = "timeline" | "mentions" | "profile";

// Feed → object-store name. "timeline" keeps the original "posts" name so the
// v1 store carries over without a data migration.
const STORE: Record<Feed, string> = {
  timeline: "posts",
  mentions: "mentions",
  profile: "profile",
};

interface PostRecord {
  key: string; // `${platform}:${platformPostId}`
  postedAt: string; // ISO — indexed; ISO sorts lexicographically by time
  post: ClientPost;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORE)) {
        if (!db.objectStoreNames.contains(name)) {
          const os = db.createObjectStore(name, { keyPath: "key" });
          os.createIndex("postedAt", "postedAt");
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Upserts posts by their stable `${platform}:${platformPostId}` key. Last write
// wins, matching the server's onDuplicateKeyUpdate (fresh counts overwrite).
export async function putPosts(posts: ClientPost[], feed: Feed = "timeline"): Promise<void> {
  if (posts.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE[feed], "readwrite");
    const os = transaction.objectStore(STORE[feed]);
    for (const post of posts) {
      const record: PostRecord = {
        key: storeKey(post.platform, post.platformPostId),
        postedAt: post.postedAt,
        post,
      };
      os.put(record);
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
