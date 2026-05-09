import { NextResponse } from "next/server";
import { db } from "@/db";
import { persons, platformIdentities } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { extractBannerUrl } from "@/lib/profile-meta";

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

    // Strip rawProfile (can be large) but extract bannerUrl from it so the
    // client doesn't need to know each platform's JSON shape.
    const enriched = allIdentities.map((i) => ({
      id: i.id,
      personId: i.personId,
      platform: i.platform,
      handle: i.handle,
      did: i.did,
      displayName: i.displayName,
      avatarUrl: i.avatarUrl,
      bio: i.bio,
      profileUrl: i.profileUrl,
      verifiedDomain: i.verifiedDomain,
      isFollowed: i.isFollowed,
      bannerUrl: extractBannerUrl(i.platform, i.rawProfile),
    }));

    const personsWithIdentities = allPersons.map((person) => ({
      ...person,
      identities: enriched.filter((i) => i.personId === person.id),
    }));

    // Unlinked identities (no person assigned)
    const unlinked = enriched.filter((i) => i.personId === null);

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
