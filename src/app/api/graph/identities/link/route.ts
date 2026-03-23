import { NextResponse } from "next/server";
import { db } from "@/db";
import { persons, platformIdentities } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { identityIds } = await request.json();

    if (!Array.isArray(identityIds) || identityIds.length < 2) {
      return NextResponse.json(
        { error: "Provide at least 2 identity IDs to link" },
        { status: 400 }
      );
    }

    // Fetch the identities, filtering by userId
    const identities = await db
      .select()
      .from(platformIdentities)
      .where(
        and(
          inArray(platformIdentities.id, identityIds),
          eq(platformIdentities.userId, userId)
        )
      );

    if (identities.length < 2) {
      return NextResponse.json(
        { error: "Could not find the specified identities" },
        { status: 404 }
      );
    }

    // Check if any already belong to a person
    const existingPersonId = identities.find((i) => i.personId)?.personId;

    let personId: number;

    if (existingPersonId) {
      // Add the unlinked ones to the existing person
      personId = existingPersonId;
    } else {
      // Create a new person
      const displayName =
        identities.find((i) => i.displayName)?.displayName || "Unknown";
      const [result] = await db.insert(persons).values({
        userId,
        displayName,
        autoMatched: false,
      });
      personId = result.insertId;
    }

    await db
      .update(platformIdentities)
      .set({ personId })
      .where(inArray(platformIdentities.id, identityIds));

    return NextResponse.json({ personId });
  } catch (err) {
    console.error("Error linking identities:", err);
    return NextResponse.json(
      { error: "Failed to link identities" },
      { status: 500 }
    );
  }
}
