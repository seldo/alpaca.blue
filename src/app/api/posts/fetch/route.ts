import { NextRequest, NextResponse } from "next/server";
import { storeBlueskyPosts, fetchAndStoreMastodonPosts } from "@/lib/posts";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const { platform } = body;

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
