import { NextResponse } from "next/server";
import { db } from "@/db";
import { persons, platformIdentities } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";

export async function GET() {
  try {
    // Persons with their linked identities
    const allPersons = await db.select().from(persons);
    const allIdentities = await db.select().from(platformIdentities);

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
