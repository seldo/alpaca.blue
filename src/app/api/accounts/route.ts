import { NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const accounts = await db
      .select({
        id: connectedAccounts.id,
        platform: connectedAccounts.platform,
        handle: connectedAccounts.handle,
        lastSyncAt: connectedAccounts.lastSyncAt,
        createdAt: connectedAccounts.createdAt,
      })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, userId));

    return NextResponse.json(accounts);
  } catch (error) {
    console.error("[api/accounts] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch accounts" },
      { status: 500 }
    );
  }
}
