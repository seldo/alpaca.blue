import { NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";

export async function GET() {
  try {
    const accounts = await db
      .select({
        id: connectedAccounts.id,
        platform: connectedAccounts.platform,
        handle: connectedAccounts.handle,
        lastSyncAt: connectedAccounts.lastSyncAt,
        createdAt: connectedAccounts.createdAt,
      })
      .from(connectedAccounts);

    return NextResponse.json(accounts);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch accounts" },
      { status: 500 }
    );
  }
}
