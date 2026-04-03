import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const { statusId, content } = body;
    if (!statusId || !content?.trim()) {
      return NextResponse.json({ error: "statusId and content are required" }, { status: 400 });
    }

    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
      .limit(1);

    if (!account?.accessToken || !account.instanceUrl) {
      return NextResponse.json({ error: "Mastodon account not connected" }, { status: 400 });
    }

    const response = await fetch(`${account.instanceUrl}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: content.trim(), in_reply_to_id: statusId }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Mastodon reply failed:", response.status, text);
      return NextResponse.json({ error: "Failed to post reply to Mastodon" }, { status: 502 });
    }

    const status = await response.json();
    return NextResponse.json({ id: status.id, url: status.url });
  } catch (err) {
    console.error("[mastodon/reply] error:", err);
    return NextResponse.json({ error: "Failed to post reply" }, { status: 500 });
  }
}
