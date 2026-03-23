import { db } from "@/db";
import { connectedAccounts, platformIdentities } from "@/db/schema";
import { eq, and } from "drizzle-orm";

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
  let imported = 0;
  const errors: Array<{ handle: string; error: string }> = [];

  for (const follow of follows) {
    try {
      await db
        .insert(platformIdentities)
        .values({
          userId,
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to import ${follow.handle}:`, message);
      errors.push({ handle: follow.handle, error: message });
    }
  }

  await db
    .update(connectedAccounts)
    .set({ lastSyncAt: new Date() })
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.platform, "bluesky")
      )
    );

  if (errors.length > 0) {
    console.error(`Import completed with ${errors.length} failures:`, errors);
  }

  return { imported, errors: errors.length };
}
