import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Prefix all keys so dev and prod don't collide on the shared Redis instance.
// Set REDIS_KEY_PREFIX=dev: in .env.local for local development.
export const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? "";

// Post fetching, timeline/reaction caching, and the realtime worker all moved
// to the client, so their Redis keys are gone. What remains uses Redis directly
// with KEY_PREFIX (Bluesky OAuth state/session + the identity profile-refresh
// debounce in bluesky-server / identities routes).
//
// `identity:profile_fetched:{id}` (60s) — set inline by identities/[id]/refresh.
