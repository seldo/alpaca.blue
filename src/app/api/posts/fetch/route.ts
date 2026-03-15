import { NextRequest, NextResponse } from "next/server";
import { storeBlueskyPosts, fetchAndStoreMastodonPosts } from "@/lib/posts";

export async function POST(request: NextRequest) {
  try {
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
      const result = await storeBlueskyPosts(posts);
      return NextResponse.json({ platform: "bluesky", stored: result.stored });
    }

    if (platform === "mastodon") {
      const result = await fetchAndStoreMastodonPosts();
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
