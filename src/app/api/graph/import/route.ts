import { NextRequest, NextResponse } from "next/server";
import { storeBlueskyFollows } from "@/lib/bluesky";
import { importMastodonFollows } from "@/lib/mastodon";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const { platform } = body;

    if (platform === "bluesky") {
      const agent = await getServerBlueskyAgent(userId);
      if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

      const [user] = await db.select({ blueskyDid: users.blueskyDid }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.blueskyDid) return NextResponse.json({ error: "No Bluesky account" }, { status: 400 });

      const allFollows: Array<{ handle: string; did: string; displayName?: string; avatar?: string; description?: string }> = [];
      let cursor: string | undefined;
      do {
        const response = await agent.getFollows({ actor: user.blueskyDid, limit: 100, cursor });
        for (const follow of response.data.follows) {
          allFollows.push({ handle: follow.handle, did: follow.did, displayName: follow.displayName, avatar: follow.avatar, description: follow.description });
        }
        cursor = response.data.cursor;
      } while (cursor);

      const result = await storeBlueskyFollows(allFollows, userId);
      return NextResponse.json({ platform: "bluesky", imported: result.imported });
    }

    if (platform === "mastodon") {
      const result = await importMastodonFollows(userId);
      return NextResponse.json({
        platform: "mastodon",
        imported: result.imported,
      });
    }

    return NextResponse.json(
      { error: "Invalid platform. Use 'bluesky' or 'mastodon'." },
      { status: 400 }
    );
  } catch (error) {
    console.error("Import error:", error);
    const message =
      error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
