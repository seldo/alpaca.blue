import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { fetchMastodonReactions } from "@/lib/posts";
import { groupReactions } from "@/lib/reactions";
import type { RawReaction } from "@/lib/reactions";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const blueskyReactions: RawReaction[] = Array.isArray(body.blueskyReactions)
      ? body.blueskyReactions
      : [];

    const mastodonReactions = await fetchMastodonReactions(userId).catch((err) => {
      console.error("[reactions/fetch] Mastodon reactions error:", err);
      return [] as RawReaction[];
    });

    const reactionGroups = groupReactions([...blueskyReactions, ...mastodonReactions]);
    return NextResponse.json({ reactionGroups });
  } catch (err) {
    console.error("[reactions/fetch] Error:", err);
    return NextResponse.json({ reactionGroups: [] });
  }
}
