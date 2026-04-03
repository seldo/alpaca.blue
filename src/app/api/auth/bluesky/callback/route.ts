import { NextRequest, NextResponse } from "next/server";
import { Agent } from "@atproto/api";
import { getNodeOAuthClient } from "@/lib/bluesky-server";
import { db } from "@/db";
import { users, connectedAccounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const client = await getNodeOAuthClient();

    const { session } = await client.callback(params);
    const agent = new Agent(session);

    // Fetch profile to get handle, avatar, displayName
    const profile = await agent.getProfile({ actor: session.did });

    const { handle, displayName, avatar: avatarUrl } = profile.data;

    // Find or create user by Bluesky DID
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.blueskyDid, session.did))
      .limit(1);

    if (!user) {
      const [result] = await db.insert(users).values({
        blueskyDid: session.did,
        blueskyHandle: handle,
        displayName: displayName || null,
        avatarUrl: avatarUrl || null,
      });
      [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, result.insertId))
        .limit(1);
    } else {
      await db
        .update(users)
        .set({
          blueskyHandle: handle,
          ...(displayName ? { displayName } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
        })
        .where(eq(users.id, user.id));
    }

    // Save connected account
    await db
      .insert(connectedAccounts)
      .values({
        userId: user.id,
        platform: "bluesky",
        handle,
        did: session.did,
      })
      .onDuplicateKeyUpdate({
        set: { did: session.did, updatedAt: new Date() },
      });

    // Set iron-session cookie
    const ironSession = await getSession();
    ironSession.userId = user.id;
    await ironSession.save();

    // Redirect to home
    const appUrl = (process.env.APP_URL || "https://alpaca.blue").replace(/\/$/, "");
    return NextResponse.redirect(`${appUrl}/`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth callback failed";
    console.error("[auth/bluesky/callback]", err);
    const appUrl = (process.env.APP_URL || "https://alpaca.blue").replace(/\/$/, "");
    return NextResponse.redirect(`${appUrl}/login?error=${encodeURIComponent(message)}`);
  }
}
