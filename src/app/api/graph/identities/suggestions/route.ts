import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  matchSuggestions,
  platformIdentities,
  persons,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const suggestions = await db
      .select()
      .from(matchSuggestions)
      .where(
        and(
          eq(matchSuggestions.status, "pending"),
          eq(matchSuggestions.userId, userId)
        )
      );

    if (suggestions.length === 0) {
      return NextResponse.json([]);
    }

    // Fetch related identities
    const identityIds = [
      ...new Set(
        suggestions.flatMap((s) => [s.blueskyIdentityId, s.mastodonIdentityId])
      ),
    ];
    const identities = await db
      .select()
      .from(platformIdentities)
      .where(inArray(platformIdentities.id, identityIds));

    const identityMap = new Map(identities.map((i) => [i.id, i]));

    const enriched = suggestions.map((s) => ({
      ...s,
      bluesky: identityMap.get(s.blueskyIdentityId),
      mastodon: identityMap.get(s.mastodonIdentityId),
    }));

    return NextResponse.json(enriched);
  } catch (err) {
    console.error("Error fetching suggestions:", err);
    return NextResponse.json(
      { error: "Failed to fetch suggestions" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { suggestionId, action } = await request.json();

    if (!suggestionId || !["confirm", "reject"].includes(action)) {
      return NextResponse.json(
        { error: "Missing suggestionId or invalid action" },
        { status: 400 }
      );
    }

    // Verify suggestion belongs to this user
    const [suggestion] = await db
      .select()
      .from(matchSuggestions)
      .where(
        and(
          eq(matchSuggestions.id, suggestionId),
          eq(matchSuggestions.userId, userId)
        )
      );

    if (!suggestion) {
      return NextResponse.json(
        { error: "Suggestion not found" },
        { status: 404 }
      );
    }

    if (action === "reject") {
      await db
        .update(matchSuggestions)
        .set({ status: "rejected" })
        .where(eq(matchSuggestions.id, suggestionId));
      return NextResponse.json({ status: "rejected" });
    }

    // Confirm: create person and link identities
    const [bluesky] = await db
      .select()
      .from(platformIdentities)
      .where(eq(platformIdentities.id, suggestion.blueskyIdentityId));
    const [mastodon] = await db
      .select()
      .from(platformIdentities)
      .where(eq(platformIdentities.id, suggestion.mastodonIdentityId));

    const displayName =
      bluesky?.displayName || mastodon?.displayName || "Unknown";

    const [result] = await db.insert(persons).values({
      userId,
      displayName,
      autoMatched: false,
      matchConfidence: suggestion.llmConfidence,
    });

    const personId = result.insertId;

    await db
      .update(platformIdentities)
      .set({ personId })
      .where(
        inArray(platformIdentities.id, [
          suggestion.blueskyIdentityId,
          suggestion.mastodonIdentityId,
        ])
      );

    await db
      .update(matchSuggestions)
      .set({ status: "confirmed", personId })
      .where(eq(matchSuggestions.id, suggestionId));

    return NextResponse.json({ status: "confirmed", personId });
  } catch (err) {
    console.error("Error processing suggestion:", err);
    return NextResponse.json(
      { error: "Failed to process suggestion" },
      { status: 500 }
    );
  }
}
