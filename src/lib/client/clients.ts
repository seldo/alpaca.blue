// Lazy, session-shared platform clients for code that isn't inside a feed hook
// (e.g. PostCard resolving a cross-post mirror). Created once and reused.

import { BlueskyClient } from "./bluesky";
import { getMastodonCredentials, type MastodonCredentials } from "./mastodon";

let mastoPromise: Promise<MastodonCredentials | null> | null = null;

// BlueskyClient.create() already returns the one shared instance.
export function sharedBluesky(): Promise<BlueskyClient | null> {
  return BlueskyClient.create();
}

export function sharedMastodon(): Promise<MastodonCredentials | null> {
  return (mastoPromise ??= getMastodonCredentials());
}

export function resetSharedClients(): void {
  mastoPromise = null;
  BlueskyClient.resetShared();
}
