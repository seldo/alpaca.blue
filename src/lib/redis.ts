import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Cache keys
export const keys = {
  mastodonFetched: (userId: number, type: "timeline" | "mentions") =>
    `mastodon:fetched:${userId}:${type}`,
  timelineCache: (userId: number, type: "timeline" | "mentions") =>
    `timeline:cache:${userId}:${type}`,
};

// TTLs (seconds)
export const TTL = {
  mastodonFetchDebounce: 30,
  timelineCache: 60,
};
