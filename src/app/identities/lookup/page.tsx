import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { platformIdentities } from "@/db/schema";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface LookupParams {
  platform?: string;
  did?: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

export default async function LookupIdentityPage({
  searchParams,
}: {
  searchParams: Promise<LookupParams>;
}) {
  const session = await requireSession();
  if (!session) redirect("/login");
  const userId = session.userId!;

  const params = await searchParams;
  const platform = params.platform === "bluesky" || params.platform === "mastodon" ? params.platform : null;
  const did = params.did?.trim() || null;
  const handle = params.handle?.trim() || null;
  if (!platform || !handle) redirect("/mentions");

  // Try to find an existing identity. Prefer DID for Bluesky (handles can change),
  // fall back to handle. Mastodon's stable identifier is the @user@instance handle.
  let identity: { id: number; personId: number | null } | undefined;

  if (platform === "bluesky" && did) {
    const rows = await db
      .select({ id: platformIdentities.id, personId: platformIdentities.personId })
      .from(platformIdentities)
      .where(and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "bluesky"),
        eq(platformIdentities.did, did),
      ))
      .limit(1);
    identity = rows[0];
  }

  if (!identity) {
    const rows = await db
      .select({ id: platformIdentities.id, personId: platformIdentities.personId })
      .from(platformIdentities)
      .where(and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, platform),
        eq(platformIdentities.handle, handle),
      ))
      .limit(1);
    identity = rows[0];
  }

  // Create if missing. Use onDuplicateKeyUpdate to be race-safe on the
  // (userId, platform, handle) unique index, then re-select to get the row.
  if (!identity) {
    const profileUrl =
      platform === "bluesky"
        ? `https://bsky.app/profile/${handle.replace(/^@/, "")}`
        : (() => {
            const m = handle.match(/^@?([^@]+)@(.+)$/);
            return m ? `https://${m[2]}/@${m[1]}` : null;
          })();

    await db.insert(platformIdentities).values({
      userId,
      platform,
      handle,
      did: did || null,
      displayName: params.displayName || null,
      avatarUrl: params.avatarUrl || null,
      profileUrl,
      isFollowed: false,
    }).onDuplicateKeyUpdate({
      set: {
        displayName: sql`values(${platformIdentities.displayName})`,
        avatarUrl: sql`values(${platformIdentities.avatarUrl})`,
        ...(did ? { did: sql`values(${platformIdentities.did})` } : {}),
      },
    });

    const rows = await db
      .select({ id: platformIdentities.id, personId: platformIdentities.personId })
      .from(platformIdentities)
      .where(and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, platform),
        eq(platformIdentities.handle, handle),
      ))
      .limit(1);
    identity = rows[0];
  }

  if (!identity) redirect("/mentions");

  if (identity.personId) redirect(`/persons/${identity.personId}`);
  redirect(`/identities/${identity.id}`);
}
