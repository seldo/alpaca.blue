import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// POST { statusId, undo? } → reblog or unreblog a Mastodon status by its
// platform-side ID. Mirrors /api/mastodon/reply: useful for cross-platform
// fanout where we don't have an internal posts.id row for the mirror.
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const statusId: string | undefined = body.statusId;
    const undo: boolean = !!body.undo;
    if (!statusId) {
      return NextResponse.json({ error: "statusId is required" }, { status: 400 });
    }

    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
      .limit(1);

    if (!account?.accessToken || !account.instanceUrl) {
      return NextResponse.json({ error: "Mastodon account not connected" }, { status: 400 });
    }

    const action = undo ? "unreblog" : "reblog";
    const response = await fetch(
      `${account.instanceUrl}/api/v1/statuses/${encodeURIComponent(statusId)}/${action}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${account.accessToken}` },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`Mastodon ${action} failed:`, response.status, text);
      return NextResponse.json({ error: `Failed to ${action}` }, { status: 502 });
    }

    const status = await response.json();
    // For reblog, the API returns the wrapper status; the inner reblog
    // carries the updated counts. For unreblog, the returned status is the
    // original. Read counts off whichever is present.
    const target = status.reblog || status;
    return NextResponse.json({
      reblogged: !undo,
      repostCount: target.reblogs_count,
    });
  } catch (err) {
    console.error("[mastodon/repost] error:", err);
    return NextResponse.json({ error: "Failed to repost" }, { status: 500 });
  }
}
