import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts, platformIdentities, posts, persons, matchSuggestions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { platform } = await request.json();

    if (platform === "mastodon") {
      // Remove Mastodon connected account
      await db
        .delete(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.userId, userId),
            eq(connectedAccounts.platform, "mastodon")
          )
        );

      // Remove Mastodon posts
      await db
        .delete(posts)
        .where(
          and(eq(posts.userId, userId), eq(posts.platform, "mastodon"))
        );

      // Keep the Mastodon platform identities — just mark them unfollowed.
      // Deleting them used to take their cross-platform person links with them
      // (the matched person survived with only its Bluesky side, and a later
      // reconnect re-imported the Mastodon side as fresh rows with no person),
      // orphaning every prior identity match. Retaining the rows means a
      // reconnect's upsert (keyed on user+platform+handle) preserves person_id
      // and just flips isFollowed back on. Use /disconnect "all" for a full wipe.
      await db
        .update(platformIdentities)
        .set({ isFollowed: false })
        .where(
          and(
            eq(platformIdentities.userId, userId),
            eq(platformIdentities.platform, "mastodon")
          )
        );

      return NextResponse.json({ ok: true, platform: "mastodon" });
    }

    if (platform === "all") {
      // Nuclear option: wipe everything for this user
      await db.delete(posts).where(eq(posts.userId, userId));
      await db.delete(matchSuggestions).where(eq(matchSuggestions.userId, userId));
      await db.delete(platformIdentities).where(eq(platformIdentities.userId, userId));
      await db.delete(persons).where(eq(persons.userId, userId));
      await db.delete(connectedAccounts).where(eq(connectedAccounts.userId, userId));

      return NextResponse.json({ ok: true, platform: "all" });
    }

    return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
  } catch (err) {
    console.error("Disconnect error:", err);
    return NextResponse.json(
      { error: "Failed to disconnect account" },
      { status: 500 }
    );
  }
}
