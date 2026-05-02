import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, platformIdentities } from "@/db/schema";
import { eq, lt, desc, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { fetchAndStoreAuthorPostsForIdentity } from "@/lib/posts";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { id } = await params;
    const identityId = parseInt(id);
    if (isNaN(identityId)) {
      return NextResponse.json({ error: "Invalid identity ID" }, { status: 400 });
    }

    // Fetch the identity, verify it belongs to this user
    const [identity] = await db
      .select()
      .from(platformIdentities)
      .where(and(eq(platformIdentities.id, identityId), eq(platformIdentities.userId, userId)))
      .limit(1);

    if (!identity) {
      return NextResponse.json({ error: "Identity not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);

    // Pull a fresh page directly from the platform before reading the DB.
    // Reset the per-identity cursor on a fresh visit (no API cursor) so we
    // start from the latest; otherwise advance through the author's history.
    await fetchAndStoreAuthorPostsForIdentity(
      userId,
      { id: identity.id, platform: identity.platform, did: identity.did, handle: identity.handle },
      { reset: !cursor },
    ).catch(() => {});

    const conditions = [
      eq(posts.platformIdentityId, identityId),
      eq(posts.userId, userId),
    ];
    if (cursor) {
      conditions.push(lt(posts.postedAt, new Date(cursor)));
    }

    const rows = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.postedAt))
      .limit(limit);

    const result = rows.map((post) => ({
      id: post.id,
      platform: post.platform,
      platformPostId: post.platformPostId,
      platformPostCid: post.platformPostCid || null,
      postUrl: post.postUrl || null,
      content: post.content,
      contentHtml: post.contentHtml,
      media: typeof post.media === "string" ? JSON.parse(post.media) : post.media,
      replyToId: post.replyToId,
      repostOfId: post.repostOfId,
      quotedPost: typeof post.quotedPost === "string" ? JSON.parse(post.quotedPost) : post.quotedPost,
      linkCard: typeof post.linkCard === "string" ? JSON.parse(post.linkCard) : post.linkCard,
      likeCount: post.likeCount,
      repostCount: post.repostCount,
      replyCount: post.replyCount,
      postedAt: post.postedAt.toISOString(),
      author: {
        id: identity.id,
        handle: identity.handle,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        platform: identity.platform,
        profileUrl: identity.profileUrl,
      },
      person: null,
      alsoPostedOn: [],
    }));

    const nextCursor =
      result.length === limit ? result[result.length - 1].postedAt : null;

    return NextResponse.json({ identity, posts: result, nextCursor });
  } catch (err) {
    console.error("Identity posts error:", err);
    return NextResponse.json({ error: "Failed to fetch identity posts" }, { status: 500 });
  }
}
