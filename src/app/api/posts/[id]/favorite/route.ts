import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { id } = await params;
    const postId = parseInt(id);
    if (isNaN(postId)) {
      return NextResponse.json({ error: "Invalid post ID" }, { status: 400 });
    }

    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.userId, userId)))
      .limit(1);

    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    if (post.platform !== "mastodon") {
      return NextResponse.json(
        { error: "Server-side favorite only supported for Mastodon" },
        { status: 400 }
      );
    }

    // Get Mastodon credentials
    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.platform, "mastodon")
        )
      )
      .limit(1);

    if (!account?.accessToken || !account.instanceUrl) {
      return NextResponse.json(
        { error: "Mastodon account not connected" },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const unfavorite = body.unfavorite === true;

    const endpoint = unfavorite ? "unfavourite" : "favourite";
    const response = await fetch(
      `${account.instanceUrl}/api/v1/statuses/${post.platformPostId}/${endpoint}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${account.accessToken}` },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`Mastodon ${endpoint} failed:`, response.status, text);
      return NextResponse.json(
        { error: `Failed to ${unfavorite ? "unfavorite" : "favorite"} post` },
        { status: 502 }
      );
    }

    const status = await response.json();

    return NextResponse.json({
      favorited: status.favourited,
      likeCount: status.favourites_count,
    });
  } catch (err) {
    console.error("Favorite error:", err);
    return NextResponse.json(
      { error: "Failed to favorite post" },
      { status: 500 }
    );
  }
}
