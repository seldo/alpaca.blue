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
    const content = (body.content || "").trim();
    if (!content) {
      return NextResponse.json({ error: "Post cannot be empty" }, { status: 400 });
    }

    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.platform, "mastodon")
        )
      )
      .limit(1);

    if (!account?.accessToken || !account.instanceUrl) {
      return NextResponse.json(
        { error: "Mastodon account not connected" },
        { status: 400 }
      );
    }

    const response = await fetch(`${account.instanceUrl}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: content }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Mastodon post failed:", response.status, text);
      return NextResponse.json({ error: "Failed to post to Mastodon" }, { status: 502 });
    }

    const status = await response.json();
    return NextResponse.json({ id: status.id, url: status.url });
  } catch (err) {
    console.error("Create post error:", err);
    return NextResponse.json({ error: "Failed to create post" }, { status: 500 });
  }
}
