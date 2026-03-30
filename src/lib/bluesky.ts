import { db } from "@/db";
import { connectedAccounts, platformIdentities } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

export interface BlueskyFollowData {
  handle: string;
  did: string;
  displayName?: string;
  avatar?: string;
  description?: string;
}

// Store follows sent from the browser-side agent
export async function storeBlueskyFollows(
  follows: BlueskyFollowData[],
  userId: number
) {
  if (follows.length === 0) return { imported: 0, errors: 0 };

  const rows = follows.map((follow) => ({
    userId,
    platform: "bluesky" as const,
    handle: follow.handle,
    did: follow.did,
    displayName: follow.displayName || null,
    avatarUrl: follow.avatar || null,
    bio: follow.description || null,
    profileUrl: `https://bsky.app/profile/${follow.handle}`,
    isFollowed: true,
    rawProfile: follow as unknown as Record<string, unknown>,
  }));

  await db.insert(platformIdentities).values(rows).onDuplicateKeyUpdate({
    set: {
      did: sql`values(${platformIdentities.did})`,
      displayName: sql`values(${platformIdentities.displayName})`,
      avatarUrl: sql`values(${platformIdentities.avatarUrl})`,
      bio: sql`values(${platformIdentities.bio})`,
      isFollowed: true,
      rawProfile: sql`values(${platformIdentities.rawProfile})`,
      updatedAt: new Date(),
    },
  });

  const imported = follows.length;

  await db
    .update(connectedAccounts)
    .set({ lastSyncAt: new Date() })
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.platform, "bluesky")
      )
    );

  return { imported, errors: 0 };
}
