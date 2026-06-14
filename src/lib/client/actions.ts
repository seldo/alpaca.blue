// Client-side write actions (Phase 4a: reactions). Dispatches like/repost to the
// right platform, performs cross-platform fanout when a native mirror exists,
// and patches the local store so optimistic state survives a reload. Mirrors
// the behaviour of the server write routes + PostCard's fanout, minus the
// bare-URL cross-post mirror (that needs the client mirror store — deferred).

import type { ClientPost } from "./types";
import { storeKey } from "./types";
import { BlueskyClient } from "./bluesky";
import { mastodonFavourite, mastodonReblog, type MastodonCredentials } from "./mastodon";
import { patchPost } from "./store";

export interface Clients {
  bluesky: BlueskyClient | null;
  mastodon: MastodonCredentials | null;
}

export async function likePost(
  post: ClientPost,
  clients: Clients,
): Promise<{ viewerLiked: boolean; likeCount: number }> {
  let result: { viewerLiked: boolean; likeCount: number };

  if (post.platform === "bluesky") {
    // Bluesky un-like needs the like record's URI, which we don't track — so
    // (matching the existing UI) only the like direction is supported.
    if (!clients.bluesky || !post.platformPostCid) throw new Error("Cannot like this post");
    await clients.bluesky.like(post.platformPostId, post.platformPostCid);
    result = { viewerLiked: true, likeCount: (post.likeCount ?? 0) + 1 };
  } else {
    if (!clients.mastodon) throw new Error("Mastodon not connected");
    result = await mastodonFavourite(clients.mastodon, post.platformPostId, post.viewerLiked);
  }

  await patchPost(storeKey(post.platform, post.platformPostId), result).catch(() => {});
  return result;
}

export async function repostPost(
  post: ClientPost,
  clients: Clients,
): Promise<{ viewerReposted: boolean; repostCount: number }> {
  const undo = post.viewerReposted;
  let result: { viewerReposted: boolean; repostCount: number };

  if (post.platform === "bluesky") {
    if (!clients.bluesky || !post.platformPostCid) throw new Error("Cannot repost this post");
    if (undo) throw new Error("Undoing a Bluesky repost isn't supported yet");
    await clients.bluesky.repost(post.platformPostId, post.platformPostCid);
    result = { viewerReposted: true, repostCount: (post.repostCount ?? 0) + 1 };
  } else {
    if (!clients.mastodon) throw new Error("Mastodon not connected");
    result = await mastodonReblog(clients.mastodon, post.platformPostId, undo);
  }

  // Cross-platform fanout (native only): if the post is also on the other
  // platform, repost that mirror too. Best-effort — a failure here doesn't fail
  // the primary repost.
  if (!undo) {
    const other = post.platform === "bluesky" ? "mastodon" : "bluesky";
    const mirror = post.alsoPostedOn?.find((p) => p.platform === other);
    if (mirror) {
      try {
        if (other === "bluesky" && clients.bluesky && mirror.platformPostCid) {
          await clients.bluesky.repost(mirror.platformPostId, mirror.platformPostCid);
        } else if (other === "mastodon" && clients.mastodon) {
          await mastodonReblog(clients.mastodon, mirror.platformPostId, false);
        }
      } catch (err) {
        console.error("[actions] cross-platform repost fanout failed:", err);
      }
    }
  }

  await patchPost(storeKey(post.platform, post.platformPostId), result).catch(() => {});
  return result;
}
