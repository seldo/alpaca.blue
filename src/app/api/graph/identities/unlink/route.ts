import { NextResponse } from "next/server";
import { db } from "@/db";
import { persons, platformIdentities } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { identityId } = await request.json();

    if (!identityId) {
      return NextResponse.json(
        { error: "Missing identityId" },
        { status: 400 }
      );
    }

    // Verify identity belongs to this user
    const [identity] = await db
      .select()
      .from(platformIdentities)
      .where(
        and(
          eq(platformIdentities.id, identityId),
          eq(platformIdentities.userId, userId)
        )
      );

    if (!identity) {
      return NextResponse.json(
        { error: "Identity not found" },
        { status: 404 }
      );
    }

    const personId = identity.personId;

    // Unlink this identity
    await db
      .update(platformIdentities)
      .set({ personId: null })
      .where(eq(platformIdentities.id, identityId));

    // If the person has no remaining identities, delete it
    if (personId) {
      const remaining = await db
        .select()
        .from(platformIdentities)
        .where(eq(platformIdentities.personId, personId));

      if (remaining.length === 0) {
        await db.delete(persons).where(eq(persons.id, personId));
      }
    }

    return NextResponse.json({ unlinked: true });
  } catch (err) {
    console.error("Error unlinking identity:", err);
    return NextResponse.json(
      { error: "Failed to unlink identity" },
      { status: 500 }
    );
  }
}
