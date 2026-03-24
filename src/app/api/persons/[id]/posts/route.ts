import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, platformIdentities, persons } from "@/db/schema";
import { eq, lt, desc, inArray, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { id } = await params;
    const personId = parseInt(id);
    if (isNaN(personId)) {
      return NextResponse.json({ error: "Invalid person ID" }, { status: 400 });
    }

    // Verify person belongs to this user
    const [person] = await db
      .select()
      .from(persons)
      .where(and(eq(persons.id, personId), eq(persons.userId, userId)));

    if (!person) {
      return NextResponse.json({ error: "Person not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);

    // Get all identity IDs for this person, filtered by userId
    const identities = await db
      .select()
      .from(platformIdentities)
      .where(
        and(
          eq(platformIdentities.personId, personId),
          eq(platformIdentities.userId, userId)
        )
      );

    if (identities.length === 0) {
      return NextResponse.json({ posts: [], nextCursor: null });
    }

    const identityIds = identities.map((i) => i.id);
    const identityMap = new Map(identities.map((i) => [i.id, i]));

    const conditions = [inArray(posts.platformIdentityId, identityIds)];
    if (cursor) {
      conditions.push(lt(posts.postedAt, new Date(cursor)));
    }

    const rows = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.postedAt))
      .limit(limit);

    const result = rows.map((post) => {
      const identity = identityMap.get(post.platformIdentityId);
      return {
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
        likeCount: post.likeCount,
        repostCount: post.repostCount,
        replyCount: post.replyCount,
        postedAt: post.postedAt.toISOString(),
        author: identity
          ? {
              id: identity.id,
              handle: identity.handle,
              displayName: identity.displayName,
              avatarUrl: identity.avatarUrl,
              platform: identity.platform,
              profileUrl: identity.profileUrl,
            }
          : null,
      };
    });

    const nextCursor =
      result.length === limit
        ? result[result.length - 1].postedAt
        : null;

    return NextResponse.json({ posts: result, nextCursor });
  } catch (err) {
    console.error("Person posts error:", err);
    return NextResponse.json(
      { error: "Failed to fetch person posts" },
      { status: 500 }
    );
  }
}
