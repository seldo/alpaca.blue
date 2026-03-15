import { NextResponse } from "next/server";
import { db } from "@/db";
import { persons, platformIdentities } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: Request) {
  try {
    const { identityId } = await request.json();

    if (!identityId) {
      return NextResponse.json(
        { error: "Missing identityId" },
        { status: 400 }
      );
    }

    const [identity] = await db
      .select()
      .from(platformIdentities)
      .where(eq(platformIdentities.id, identityId));

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
