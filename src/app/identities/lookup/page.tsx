import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { platformIdentities } from "@/db/schema";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface LookupParams {
  platform?: string;
  did?: string;
  handle?: string;
}

// Legacy entry point, kept so old links keep working. Read-only: redirects to
// the user's existing identity/person when there is one, otherwise to the
// identity page's actor mode, which loads the profile live.
//
// It used to insert a platformIdentities row for anyone it was asked about.
// That was a database write on a plain GET (so any link could add rows,
// including attacker-chosen names and avatars), and the rows cluttered the
// Identities page as "unlinked identities" that matching never considers.
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

  // Prefer DID for Bluesky (handles can change), fall back to handle.
  let identity: { id: number; personId: number | null } | undefined;
  if (platform === "bluesky" && did) {
    [identity] = await db
      .select({ id: platformIdentities.id, personId: platformIdentities.personId })
      .from(platformIdentities)
      .where(and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "bluesky"),
        eq(platformIdentities.did, did),
      ))
      .limit(1);
  }
  if (!identity) {
    [identity] = await db
      .select({ id: platformIdentities.id, personId: platformIdentities.personId })
      .from(platformIdentities)
      .where(and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, platform),
        eq(platformIdentities.handle, handle),
      ))
      .limit(1);
  }

  if (identity?.personId) redirect(`/persons/${identity.personId}`);
  if (identity) redirect(`/identities/${identity.id}`);
  const actor = platform === "bluesky" ? did || handle : handle;
  redirect(`/identities/${encodeURIComponent(`${platform}:${actor}`)}`);
}
