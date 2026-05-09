import { NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts, platformIdentities } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { extractBannerUrl } from "@/lib/profile-meta";

export async function GET() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    // Pull the connected accounts and join the matching platformIdentity row
    // for each so the client gets bio + banner + avatar in one round-trip.
    const rows = await db
      .select({
        id: connectedAccounts.id,
        platform: connectedAccounts.platform,
        handle: connectedAccounts.handle,
        lastSyncAt: connectedAccounts.lastSyncAt,
        createdAt: connectedAccounts.createdAt,
        identity: platformIdentities,
      })
      .from(connectedAccounts)
      .leftJoin(
        platformIdentities,
        and(
          eq(platformIdentities.userId, connectedAccounts.userId),
          eq(platformIdentities.platform, connectedAccounts.platform),
          eq(platformIdentities.handle, connectedAccounts.handle),
        ),
      )
      .where(eq(connectedAccounts.userId, userId));

    const accounts = rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      handle: r.handle,
      lastSyncAt: r.lastSyncAt,
      createdAt: r.createdAt,
      displayName: r.identity?.displayName ?? null,
      avatarUrl: r.identity?.avatarUrl ?? null,
      bio: r.identity?.bio ?? null,
      bannerUrl: r.identity ? extractBannerUrl(r.platform, r.identity.rawProfile) : null,
      profileUrl: r.identity?.profileUrl ?? null,
    }));

    return NextResponse.json(accounts);
  } catch (error) {
    console.error("[api/accounts] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch accounts" },
      { status: 500 }
    );
  }
}
