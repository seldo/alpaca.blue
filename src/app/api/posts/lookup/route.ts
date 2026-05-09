import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { posts, platformIdentities } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// Look up a post by platform URI. If we don't have it stored, create a stub
// from the supplied quoted-post payload so /posts/[id] always resolves.
//
// Bluesky quoted posts arrive with an at:// URI; Mastodon's are status URLs.
// Older callers that don't pass `platform` get heuristically classified by
// URI prefix.
export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();
  const userId = session.userId!;

  const body = await request.json();
  const {
    uri,
    platform: platformIn,
    postUrl,
    authorHandle,
    authorDisplayName,
    authorAvatar,
    text,
    contentHtml,
    media,
    postedAt,
  } = body;

  if (!uri) {
    return NextResponse.json({ error: "uri required" }, { status: 400 });
  }

  const platform: string =
    platformIn === "bluesky" || platformIn === "mastodon"
      ? platformIn
      : uri.startsWith("at://")
      ? "bluesky"
      : "mastodon";

  // Mastodon's platformPostId is the numeric status id; for Bluesky it's the
  // AT URI. We use whichever is unique on the source platform as the lookup
  // key.
  const platformPostId =
    platform === "mastodon" ? extractMastodonStatusId(uri, postUrl) ?? uri : uri;

  const [existing] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.userId, userId), eq(posts.platformPostId, platformPostId)))
    .limit(1);

  if (existing) {
    return NextResponse.json({ id: existing.id });
  }

  // Find or create a platform identity for the author.
  let [identity] = await db
    .select({ id: platformIdentities.id })
    .from(platformIdentities)
    .where(
      and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, platform),
        eq(platformIdentities.handle, authorHandle),
      ),
    )
    .limit(1);

  if (!identity) {
    const profileUrl =
      platform === "bluesky"
        ? `https://bsky.app/profile/${authorHandle}`
        : buildMastodonProfileUrl(authorHandle);
    const [result] = await db.insert(platformIdentities).values({
      userId,
      platform,
      handle: authorHandle,
      displayName: authorDisplayName || null,
      avatarUrl: authorAvatar || null,
      profileUrl,
      isFollowed: false,
    });
    identity = { id: result.insertId };
  }

  const [result] = await db.insert(posts).values({
    userId,
    platformIdentityId: identity.id,
    platform,
    platformPostId,
    postUrl: postUrl || (platform === "mastodon" ? uri : null),
    content: text || "",
    contentHtml: contentHtml || null,
    postedAt: postedAt ? new Date(postedAt) : new Date(),
    media: media && media.length > 0 ? media : null,
  });

  return NextResponse.json({ id: result.insertId });
}

// Mastodon status URLs look like https://instance.example/@user/123456789.
// Pull the trailing numeric id; fall back to whichever url has more shape.
function extractMastodonStatusId(uri: string, postUrl?: string | null): string | null {
  for (const candidate of [uri, postUrl]) {
    if (typeof candidate !== "string") continue;
    const m = candidate.match(/\/(\d+)(?:\?.*)?$/);
    if (m) return m[1];
  }
  return null;
}

// Mastodon handles are stored as "@user@instance"; produce the canonical
// public profile URL.
function buildMastodonProfileUrl(handle: string): string | null {
  const m = handle.match(/^@?([^@]+)@(.+)$/);
  if (!m) return null;
  return `https://${m[2]}/@${m[1]}`;
}
