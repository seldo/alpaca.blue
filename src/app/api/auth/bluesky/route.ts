import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";

// Called after browser-side OAuth completes to persist the connection server-side
export async function POST(request: NextRequest) {
  try {
    const { handle, did } = await request.json();

    if (!handle || !did) {
      return NextResponse.json(
        { error: "Handle and DID are required" },
        { status: 400 }
      );
    }

    await db
      .insert(connectedAccounts)
      .values({
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

    return NextResponse.json({ handle, did });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save connection";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
