import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, platformIdentities } from "@/db/schema";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";

// Re-fetch an identity's profile from its platform and update the cached
// avatarUrl/displayName. Triggered client-side when an avatar 404s, so a
// stale CDN URL gets healed without manual intervention.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();
  const userId = session.userId!;

  const { id } = await params;
  const identityId = parseInt(id);
  if (isNaN(identityId)) {
    return NextResponse.json({ error: "Invalid identity ID" }, { status: 400 });
  }

  const [identity] = await db
    .select()
    .from(platformIdentities)
    .where(and(eq(platformIdentities.id, identityId), eq(platformIdentities.userId, userId)))
    .limit(1);

  if (!identity) {
    return NextResponse.json({ error: "Identity not found" }, { status: 404 });
  }

  let avatarUrl: string | null = identity.avatarUrl ?? null;
  let displayName: string | null = identity.displayName ?? null;

  try {
    if (identity.platform === "bluesky" && identity.did) {
      const agent = await getServerBlueskyAgent(userId);
      if (agent) {
        const res = await agent.getProfile({ actor: identity.did });
        const data = res.data as { avatar?: string; displayName?: string };
        avatarUrl = data.avatar || null;
        displayName = data.displayName || identity.displayName || null;
      }
    } else if (identity.platform === "mastodon") {
      const [account] = await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
        .limit(1);
      if (account?.accessToken && account.instanceUrl) {
        const acct = identity.handle.replace(/^@/, "");
        const r = await fetch(
          `${account.instanceUrl}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
          { headers: { Authorization: `Bearer ${account.accessToken}` } },
        );
        if (r.ok) {
          const data = (await r.json()) as { avatar?: string; display_name?: string };
          avatarUrl = data.avatar || null;
          displayName = data.display_name || identity.displayName || null;
        }
      }
    }
  } catch (err) {
    console.error("[identities/refresh] platform fetch failed", err);
  }

  if (avatarUrl !== identity.avatarUrl || displayName !== identity.displayName) {
    await db
      .update(platformIdentities)
      .set({ avatarUrl, displayName })
      .where(eq(platformIdentities.id, identityId));
  }

  return NextResponse.json({ avatarUrl, displayName });
}
