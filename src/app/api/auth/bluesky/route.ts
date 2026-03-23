import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, connectedAccounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/session";

// Called after browser-side OAuth completes.
// Creates or finds the user by Bluesky DID, sets the session, and saves the connected account.
export async function POST(request: NextRequest) {
  try {
    const { handle, did } = await request.json();

    if (!handle || !did) {
      return NextResponse.json(
        { error: "Handle and DID are required" },
        { status: 400 }
      );
    }

    // Find or create user by Bluesky DID
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.blueskyDid, did))
      .limit(1);

    if (!user) {
      const [result] = await db.insert(users).values({
        blueskyDid: did,
        blueskyHandle: handle,
      });
      [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, result.insertId))
        .limit(1);
    } else {
      // Update handle in case it changed
      await db
        .update(users)
        .set({ blueskyHandle: handle })
        .where(eq(users.id, user.id));
    }

    // Set session
    const session = await getSession();
    session.userId = user.id;
    await session.save();

    // Save connected account
    await db
      .insert(connectedAccounts)
      .values({
        userId: user.id,
        platform: "bluesky",
        handle,
        did,
      })
      .onDuplicateKeyUpdate({
        set: {
          did,
          updatedAt: new Date(),
        },
      });

    return NextResponse.json({ userId: user.id, handle, did });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save connection";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
