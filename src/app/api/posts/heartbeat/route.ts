import { NextRequest, NextResponse } from "next/server";
import {
  fetchAndStoreBlueskyPosts,
  fetchAndStoreBlueskyMentions,
  fetchAndStoreMastodonPosts,
  fetchAndStoreMastodonMentions,
  fetchBlueskyReactions,
  fetchMastodonReactions,
  queryTimeline,
} from "@/lib/posts";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { redis, keys } from "@/lib/redis";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json().catch(() => ({}));
    const { force } = body;

    if (force) {
      await Promise.all([
        redis.del(keys.blueskyFetched(userId, "timeline")).catch(() => {}),
        redis.del(keys.mastodonFetched(userId, "timeline")).catch(() => {}),
        redis.del(keys.timelineCache(userId, "timeline")).catch(() => {}),
        redis.del(keys.blueskyFetched(userId, "mentions")).catch(() => {}),
        redis.del(keys.mastodonFetched(userId, "mentions")).catch(() => {}),
        redis.del(keys.timelineCache(userId, "mentions")).catch(() => {}),
        redis.del(keys.blueskyReactions(userId)).catch(() => {}),
        redis.del(keys.mastodonReactions(userId)).catch(() => {}),
      ]);
    }

    const results = await Promise.allSettled([
      fetchAndStoreBlueskyPosts(userId),
      fetchAndStoreMastodonPosts(userId),
      fetchAndStoreBlueskyMentions(userId),
      fetchAndStoreMastodonMentions(userId),
      fetchBlueskyReactions(userId),
      fetchMastodonReactions(userId),
    ]);
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[heartbeat] fetch[${i}] error:`, r.reason);
      }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[heartbeat] error:", error);
    const message = error instanceof Error ? error.message : "Heartbeat failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
