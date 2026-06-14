// Lazy, session-shared platform clients for code that isn't inside a feed hook
// (e.g. PostCard resolving a cross-post mirror). Created once and reused.

import { BlueskyClient } from "./bluesky";
import { getMastodonCredentials, type MastodonCredentials } from "./mastodon";

let bskyPromise: Promise<BlueskyClient | null> | null = null;
let mastoPromise: Promise<MastodonCredentials | null> | null = null;

export function sharedBluesky(): Promise<BlueskyClient | null> {
  return (bskyPromise ??= BlueskyClient.create());
}

export function sharedMastodon(): Promise<MastodonCredentials | null> {
  return (mastoPromise ??= getMastodonCredentials());
}
