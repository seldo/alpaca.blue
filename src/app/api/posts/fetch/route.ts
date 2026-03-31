import { NextRequest, NextResponse } from "next/server";
import {
  storeBlueskyPosts,
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
    const { platform, type } = body;

    if (platform === "all") {
      // Combined: store bluesky posts + fetch mastodon in parallel, then return timeline
      const { posts: blueskyPosts } = body;
      const limit = Math.min(parseInt(body.limit || "50"), 100);

      const [blueskyResult, mastodonResult] = await Promise.allSettled([
        blueskyPosts?.length > 0
          ? storeBlueskyPosts(blueskyPosts, userId)
          : Promise.resolve(),
        type === "mentions"
          ? fetchAndStoreMastodonMentions(userId)
          : fetchAndStoreMastodonPosts(userId),
      ]);
      if (blueskyResult.status === "rejected") {
        console.error("[posts/fetch] Bluesky store error:", blueskyResult.reason);
      }
      if (mastodonResult.status === "rejected") {
        console.error("[posts/fetch] Mastodon fetch error:", mastodonResult.reason);
      }

      const result = await queryTimeline(userId, { type, limit });
      return NextResponse.json(result);
    }

    if (platform === "bluesky") {
      const { posts } = body;
      if (!posts || !Array.isArray(posts)) {
        return NextResponse.json(
          { error: "posts array is required for Bluesky" },
          { status: 400 }
        );
      }
      const result = await storeBlueskyPosts(posts, userId);
      return NextResponse.json({ platform: "bluesky", stored: result.stored });
    }

    if (platform === "mastodon") {
      if (type === "mentions") {
        const result = await fetchAndStoreMastodonMentions(userId);
        return NextResponse.json({
          platform: "mastodon",
          type: "mentions",
          stored: result.stored,
        });
      }
      const result = await fetchAndStoreMastodonPosts(userId);
      return NextResponse.json({
        platform: "mastodon",
        stored: result.stored,
      });
    }

    return NextResponse.json(
      { error: "Invalid platform" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Post fetch error:", error);
    const message =
      error instanceof Error ? error.message : "Post fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
