import { NextResponse } from "next/server";
import { db } from "@/db";
import { persons, platformIdentities } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    // Persons with their linked identities
    const allPersons = await db
      .select()
      .from(persons)
      .where(eq(persons.userId, userId));
    const allIdentities = await db
      .select()
      .from(platformIdentities)
      .where(eq(platformIdentities.userId, userId));

    const personsWithIdentities = allPersons.map((person) => ({
      ...person,
      identities: allIdentities.filter((i) => i.personId === person.id),
    }));

    // Unlinked identities (no person assigned)
    const unlinked = allIdentities.filter((i) => i.personId === null);

    return NextResponse.json({
      persons: personsWithIdentities,
      unlinked,
    });
  } catch (err) {
    console.error("Error fetching identities:", err);
    return NextResponse.json(
      { error: "Failed to fetch identities" },
      { status: 500 }
    );
  }
}
