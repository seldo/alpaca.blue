import { BskyAgent } from "@atproto/api";
import { db } from "@/db";
import { connectedAccounts, platformIdentities, persons } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function authenticateBluesky(
  handle: string,
  appPassword: string
) {
  const agent = new BskyAgent({ service: "https://bsky.social" });

  const response = await agent.login({
    identifier: handle,
    password: appPassword,
  });

  if (!response.success) {
    throw new Error("Bluesky authentication failed");
  }

  // Upsert connected account
  await db
    .insert(connectedAccounts)
    .values({
      platform: "bluesky",
      handle: response.data.handle,
      did: response.data.did,
      accessToken: response.data.accessJwt,
      refreshToken: response.data.refreshJwt,
    })
    .onDuplicateKeyUpdate({
      set: {
        did: response.data.did,
        accessToken: response.data.accessJwt,
        refreshToken: response.data.refreshJwt,
        updatedAt: new Date(),
      },
    });

  return {
    handle: response.data.handle,
    did: response.data.did,
  };
}

export async function getBlueskyAgent(): Promise<BskyAgent | null> {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.platform, "bluesky"))
    .limit(1);

  if (!account?.accessToken) return null;

  const agent = new BskyAgent({ service: "https://bsky.social" });

  try {
    await agent.resumeSession({
      did: account.did!,
      handle: account.handle,
      accessJwt: account.accessToken,
      refreshJwt: account.refreshToken || "",
      active: true,
    });
  } catch {
    // Try refresh
    if (account.refreshToken) {
      await agent.resumeSession({
        did: account.did!,
        handle: account.handle,
        accessJwt: account.accessToken,
        refreshJwt: account.refreshToken,
        active: true,
      });
    } else {
      return null;
    }
  }

  return agent;
}

export async function importBlueskyFollows() {
  const agent = await getBlueskyAgent();
  if (!agent || !agent.session) throw new Error("Not authenticated with Bluesky");

  const did = agent.session.did;
  let cursor: string | undefined;
  let imported = 0;

  do {
    const response = await agent.getFollows({
      actor: did,
      limit: 100,
      cursor,
    });

    for (const follow of response.data.follows) {
      // Upsert platform identity
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

    cursor = response.data.cursor;
  } while (cursor);

  // Update last sync timestamp
  await db
    .update(connectedAccounts)
    .set({ lastSyncAt: new Date() })
    .where(eq(connectedAccounts.platform, "bluesky"));

  return { imported };
}
