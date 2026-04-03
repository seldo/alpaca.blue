import { NextRequest, NextResponse } from "next/server";
import {
  fetchAndStoreBlueskyPosts,
  fetchAndStoreBlueskyMentions,
  fetchAndStoreMastodonPosts,
  fetchAndStoreMastodonMentions,
  queryTimeline,
} from "@/lib/posts";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const { type } = body;
    const limit = Math.min(parseInt(body.limit || "50"), 100);

    const isMentions = type === "mentions";

    const [blueskyResult, mastodonResult] = await Promise.allSettled([
      isMentions
        ? fetchAndStoreBlueskyMentions(userId)
        : fetchAndStoreBlueskyPosts(userId),
      isMentions
        ? fetchAndStoreMastodonMentions(userId)
        : fetchAndStoreMastodonPosts(userId),
    ]);

    if (blueskyResult.status === "rejected") {
      console.error("[posts/fetch] Bluesky fetch error:", blueskyResult.reason);
    }
    if (mastodonResult.status === "rejected") {
      console.error("[posts/fetch] Mastodon fetch error:", mastodonResult.reason);
    }

    const result = await queryTimeline(userId, { type, limit });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Post fetch error:", error);
    const message = error instanceof Error ? error.message : "Post fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
