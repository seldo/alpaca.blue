import { NextRequest, NextResponse } from "next/server";
import { RichText } from "@atproto/api";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { posts, connectedAccounts, crossPostMirrors } from "@/db/schema";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { redis, keys } from "@/lib/redis";

// Posts the original post's URL to the target platform AS the user, then
// records the resulting status as a mirror of the original. The timeline
// merge uses these records to fold the bare-URL post back into the original
// instead of showing it as a separate post.
export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();
  const userId = session.userId!;

  const body = await request.json();
  const originalPostId = Number(body.originalPostId);
  const targetPlatform = body.targetPlatform;
  if (!Number.isFinite(originalPostId) || originalPostId <= 0) {
    return NextResponse.json({ error: "originalPostId required" }, { status: 400 });
  }
  if (targetPlatform !== "bluesky" && targetPlatform !== "mastodon") {
    return NextResponse.json({ error: "targetPlatform must be bluesky or mastodon" }, { status: 400 });
  }

  const [original] = await db
    .select()
    .from(posts)
    .where(and(eq(posts.id, originalPostId), eq(posts.userId, userId)))
    .limit(1);
  if (!original) {
    return NextResponse.json({ error: "Original post not found" }, { status: 404 });
  }
  if (original.platform === targetPlatform) {
    return NextResponse.json({ error: "Original is already on target platform" }, { status: 400 });
  }
  if (!original.postUrl) {
    return NextResponse.json({ error: "Original has no URL" }, { status: 400 });
  }

  let mirrorPlatformPostId: string;

  try {
    if (targetPlatform === "bluesky") {
      const agent = await getServerBlueskyAgent(userId);
      if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });
      const rt = new RichText({ text: original.postUrl });
      await rt.detectFacets(agent);
      const result = await agent.post({ text: rt.text, facets: rt.facets });
      mirrorPlatformPostId = result.uri;
    } else {
      const [account] = await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
        .limit(1);
      if (!account?.accessToken || !account.instanceUrl) {
        return NextResponse.json({ error: "Mastodon account not connected" }, { status: 400 });
      }
      const res = await fetch(`${account.instanceUrl}/api/v1/statuses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: original.postUrl }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error("[cross-post-mirror] Mastodon post failed:", res.status, text);
        return NextResponse.json({ error: "Failed to post to Mastodon" }, { status: 502 });
      }
      const status = await res.json();
      mirrorPlatformPostId = String(status.id);
    }
  } catch (err) {
    console.error("[cross-post-mirror] post failed:", err);
    const message = err instanceof Error ? err.message : "Failed to create mirror";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  await db.insert(crossPostMirrors).values({
    userId,
    originalPostId,
    mirrorPlatform: targetPlatform,
    mirrorPlatformPostId,
  });

  // Bust timeline caches so the next read re-merges with the new mirror.
  await Promise.allSettled([
    redis.del(keys.timelineCache(userId, "timeline")),
    redis.del(keys.timelineCache(userId, "mentions")),
  ]);

  return NextResponse.json({ ok: true, mirrorPlatformPostId });
}
