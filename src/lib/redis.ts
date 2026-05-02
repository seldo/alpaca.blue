import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Prefix all keys so dev and prod don't collide on the shared Redis instance.
// Set REDIS_KEY_PREFIX=dev: in .env.local for local development.
export const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? "";

// Cache keys
export const keys = {
  mastodonFetched: (userId: number, type: "timeline" | "mentions") =>
    `${KEY_PREFIX}mastodon:fetched:${userId}:${type}`,
  blueskyFetched: (userId: number, type: "timeline" | "mentions") =>
    `${KEY_PREFIX}bluesky:fetched:${userId}:${type}`,
  timelineCache: (userId: number, type: "timeline" | "mentions") =>
    `${KEY_PREFIX}timeline:cache:${userId}:${type}`,
  mastodonReactions: (userId: number) =>
    `${KEY_PREFIX}mastodon:reactions:${userId}`,
  blueskyReactions: (userId: number) =>
    `${KEY_PREFIX}bluesky:reactions:${userId}`,
  authorFeedCursor: (userId: number, identityId: number) =>
    `${KEY_PREFIX}author:cursor:${userId}:${identityId}`,
};

// TTLs (seconds)
export const TTL = {
  mastodonFetchDebounce: 30,
  blueskyFetchDebounce: 30,
  timelineCache: 60,
  mastodonReactions: 60,
  blueskyReactions: 60,
  authorFeedCursor: 3600,
};
