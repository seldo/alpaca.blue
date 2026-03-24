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

      // Remove Mastodon platform identities (cascades match suggestions)
      await db
        .delete(platformIdentities)
        .where(
          and(
            eq(platformIdentities.userId, userId),
            eq(platformIdentities.platform, "mastodon")
          )
        );

      // Clean up orphaned persons (persons with no remaining identities)
      const userPersons = await db
        .select({ id: persons.id })
        .from(persons)
        .where(eq(persons.userId, userId));

      for (const person of userPersons) {
        const remaining = await db
          .select({ id: platformIdentities.id })
          .from(platformIdentities)
          .where(eq(platformIdentities.personId, person.id))
          .limit(1);
        if (remaining.length === 0) {
          await db.delete(persons).where(eq(persons.id, person.id));
        }
      }

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
