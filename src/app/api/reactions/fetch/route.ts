import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { fetchMastodonReactions, fetchBlueskyReactions } from "@/lib/posts";
import { groupReactions } from "@/lib/reactions";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    // Ignore body — both platforms fetched server-side now
    void request;

    const [blueskyResult, mastodonResult] = await Promise.allSettled([
      fetchBlueskyReactions(userId),
      fetchMastodonReactions(userId),
    ]);

    const blueskyReactions = blueskyResult.status === "fulfilled" ? blueskyResult.value : [];
    const mastodonReactions = mastodonResult.status === "fulfilled" ? mastodonResult.value : [];

    if (blueskyResult.status === "rejected") {
      console.error("[reactions/fetch] Bluesky reactions error:", blueskyResult.reason);
    }
    if (mastodonResult.status === "rejected") {
      console.error("[reactions/fetch] Mastodon reactions error:", mastodonResult.reason);
    }

    const reactionGroups = groupReactions([...blueskyReactions, ...mastodonReactions]);
    return NextResponse.json({ reactionGroups });
  } catch (err) {
    console.error("[reactions/fetch] Error:", err);
    return NextResponse.json({ reactionGroups: [] });
  }
}
