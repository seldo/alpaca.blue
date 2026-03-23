import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, platformIdentities, persons } from "@/db/schema";
import { eq, lt, desc, isNull, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);

    // Fetch extra to account for dedup collapsing
    const fetchLimit = Math.ceil(limit * 1.5);

    // Filter out replies in SQL so pagination isn't broken
    const conditions = [isNull(posts.replyToId)];
    if (cursor) {
      conditions.push(lt(posts.postedAt, new Date(cursor)));
    }

    const query = db
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
      .where(and(...conditions))
      .orderBy(desc(posts.postedAt))
      .limit(fetchLimit);

    const rows = await query;

    // Deduplicate by dedupeHash
    const seen = new Map<string, number>(); // hash -> index in result
    const result: Array<{
      id: number;
      platform: string;
      platformPostId: string;
      postUrl: string | null;
      content: string | null;
      contentHtml: string | null;
      media: unknown;
      replyToId: string | null;
      repostOfId: string | null;
      quotedPost: unknown;
      likeCount: number | null;
      repostCount: number | null;
      replyCount: number | null;
      postedAt: string;
      author: {
        id: number;
        handle: string;
        displayName: string | null;
        avatarUrl: string | null;
        platform: string;
        profileUrl: string | null;
      } | null;
      person: {
        id: number;
        displayName: string | null;
      } | null;
      alsoPostedOn: string[];
    }> = [];

    for (const row of rows) {
      const hash = row.post.dedupeHash;

      if (hash && seen.has(hash)) {
        // Add cross-post indicator to existing entry
        const existingIdx = seen.get(hash)!;
        if (!result[existingIdx].alsoPostedOn.includes(row.post.platform)) {
          result[existingIdx].alsoPostedOn.push(row.post.platform);
        }
        continue;
      }

      const entry = {
        id: row.post.id,
        platform: row.post.platform,
        platformPostId: row.post.platformPostId,
        postUrl: row.post.postUrl || null,
        content: row.post.content,
        contentHtml: row.post.contentHtml,
        media: typeof row.post.media === "string" ? JSON.parse(row.post.media) : row.post.media,
        replyToId: row.post.replyToId,
        repostOfId: row.post.repostOfId,
        quotedPost: typeof row.post.quotedPost === "string" ? JSON.parse(row.post.quotedPost) : row.post.quotedPost,
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
        alsoPostedOn: [],
      };

      if (hash) {
        seen.set(hash, result.length);
      }
      result.push(entry);
    }

    // Trim to requested limit
    const trimmed = result.slice(0, limit);

    const nextCursor =
      trimmed.length === limit
        ? trimmed[trimmed.length - 1].postedAt
        : null;

    return NextResponse.json({ posts: trimmed, nextCursor });
  } catch (err) {
    console.error("Timeline error:", err);
    return NextResponse.json(
      { error: "Failed to fetch timeline" },
      { status: 500 }
    );
  }
}
