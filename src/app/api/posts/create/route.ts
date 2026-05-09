import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { expandBareDomains } from "@/lib/expand-bare-domains";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const content = (body.content || "").trim();
    const mediaIds: string[] = Array.isArray(body.mediaIds) ? body.mediaIds : [];
    const inReplyToId: string | undefined =
      typeof body.inReplyToId === "string" && body.inReplyToId.length > 0
        ? body.inReplyToId
        : undefined;
    if (!content && mediaIds.length === 0) {
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

    // Promote bare hostnames to https:// URLs — Mastodon's server-side
    // linkifier only matches schema-prefixed URLs.
    const expandedContent = expandBareDomains(content);

    // Mastodon convention: replies must be prefixed with @handle of the
    // account being replied to, otherwise the recipient isn't notified and
    // the post doesn't render as part of the thread for other viewers.
    let statusText = expandedContent;
    if (inReplyToId) {
      const prefix = await mastodonReplyPrefix(
        account.instanceUrl,
        account.accessToken,
        account.handle,
        inReplyToId,
        expandedContent,
      );
      if (prefix) statusText = `${prefix} ${expandedContent}`.trim();
    }

    const response = await fetch(`${account.instanceUrl}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: statusText,
        ...(mediaIds.length > 0 ? { media_ids: mediaIds } : {}),
        ...(inReplyToId ? { in_reply_to_id: inReplyToId } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Mastodon post failed:", response.status, text);
      return NextResponse.json({ error: "Failed to post to Mastodon" }, { status: 502 });
    }

    const created = await response.json();
    return NextResponse.json({ id: created.id, url: created.url });
  } catch (err) {
    console.error("Create post error:", err);
    return NextResponse.json({ error: "Failed to create post" }, { status: 500 });
  }
}

// Looks up the in_reply_to status to find the author's acct. Returns the
// `@acct` mention to prepend, or null if it should be skipped (self-reply,
// already mentioned, or fetch failed).
async function mastodonReplyPrefix(
  instanceUrl: string,
  accessToken: string,
  ownHandle: string,
  inReplyToId: string,
  content: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `${instanceUrl}/api/v1/statuses/${encodeURIComponent(inReplyToId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const status = (await res.json()) as { account?: { acct?: string } };
    const acct = status.account?.acct;
    if (!acct) return null;

    // Normalize to user@host for comparison. Local accounts return bare
    // `username`; remote accounts return `username@host`.
    const ownInstance = new URL(instanceUrl).hostname;
    const fullAcct = acct.includes("@") ? acct : `${acct}@${ownInstance}`;
    const ownNormalized = ownHandle.replace(/^@/, "");
    if (fullAcct.toLowerCase() === ownNormalized.toLowerCase()) return null;

    const mention = `@${acct}`;
    if (new RegExp(`^@${escapeRegex(acct)}\\b`, "i").test(content.trim())) {
      return null;
    }
    return mention;
  } catch (err) {
    console.error("[mastodonReplyPrefix] lookup failed:", err);
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
