import { db } from "@/db";
import { connectedAccounts, platformIdentities } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface BlueskyFollowData {
  handle: string;
  did: string;
  displayName?: string;
  avatar?: string;
  description?: string;
}

// Store follows sent from the browser-side agent
export async function storeBlueskyFollows(follows: BlueskyFollowData[]) {
  let imported = 0;

  for (const follow of follows) {
    await db
      .insert(platformIdentities)
      .values({
        platform: "bluesky",
        handle: follow.handle,
        did: follow.did,
        displayName: follow.displayName || null,
        avatarUrl: follow.avatar || null,
        bio: follow.description || null,
        profileUrl: `https://bsky.app/profile/${follow.handle}`,
        isFollowed: true,
        rawProfile: follow as unknown as Record<string, unknown>,
      })
      .onDuplicateKeyUpdate({
        set: {
          did: follow.did,
          displayName: follow.displayName || null,
          avatarUrl: follow.avatar || null,
          bio: follow.description || null,
          isFollowed: true,
          rawProfile: follow as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        },
      });

    imported++;
  }

  await db
    .update(connectedAccounts)
    .set({ lastSyncAt: new Date() })
    .where(eq(connectedAccounts.platform, "bluesky"));

  return { imported };
}
