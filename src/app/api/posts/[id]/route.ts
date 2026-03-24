import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, platformIdentities, persons } from "@/db/schema";
import { eq, and } from "drizzle-orm";
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
    const postId = parseInt(id);
    if (isNaN(postId)) {
      return NextResponse.json({ error: "Invalid post ID" }, { status: 400 });
    }

    const [row] = await db
      .select({
        post: posts,
        identity: platformIdentities,
        person: persons,
      })
      .from(posts)
      .leftJoin(
        platformIdentities,
        eq(posts.platformIdentityId, platformIdentities.id)
      )
      .leftJoin(persons, eq(platformIdentities.personId, persons.id))
      .where(and(eq(posts.id, postId), eq(posts.userId, userId)))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    // Find cross-posts via dedupeHash
    const alsoPostedOn: Array<{ platform: string; postUrl: string | null }> = [];
    if (row.post.dedupeHash) {
      const dupes = await db
        .select({
          platform: posts.platform,
          postUrl: posts.postUrl,
        })
        .from(posts)
        .where(
          and(
            eq(posts.userId, userId),
            eq(posts.dedupeHash, row.post.dedupeHash)
          )
        );
      for (const dupe of dupes) {
        if (dupe.platform !== row.post.platform) {
          alsoPostedOn.push({
            platform: dupe.platform,
            postUrl: dupe.postUrl,
          });
        }
      }
    }

    const result = {
      id: row.post.id,
      platform: row.post.platform,
      platformPostId: row.post.platformPostId,
      platformPostCid: row.post.platformPostCid || null,
      postUrl: row.post.postUrl || null,
      content: row.post.content,
      contentHtml: row.post.contentHtml,
      media:
        typeof row.post.media === "string"
          ? JSON.parse(row.post.media)
          : row.post.media,
      replyToId: row.post.replyToId,
      repostOfId: row.post.repostOfId,
      quotedPost:
        typeof row.post.quotedPost === "string"
          ? JSON.parse(row.post.quotedPost)
          : row.post.quotedPost,
      likeCount: row.post.likeCount,
      repostCount: row.post.repostCount,
      replyCount: row.post.replyCount,
      postedAt: row.post.postedAt.toISOString(),
      author: row.identity
        ? {
            id: row.identity.id,
            handle: row.identity.handle,
            displayName: row.identity.displayName,
            avatarUrl: row.identity.avatarUrl,
            platform: row.identity.platform,
            profileUrl: row.identity.profileUrl,
          }
        : null,
      person: row.person
        ? {
            id: row.person.id,
            displayName: row.person.displayName,
          }
        : null,
      alsoPostedOn,
    };

    return NextResponse.json(result);
  } catch (err) {
    console.error("Post fetch error:", err);
    return NextResponse.json(
      { error: "Failed to fetch post" },
      { status: 500 }
    );
  }
}
