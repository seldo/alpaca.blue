import { NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// Hands the browser the credentials it needs to talk to the user's Mastodon
// instance directly. Mastodon's API is CORS-enabled and the bearer token is the
// user's own, so the browser can fetch/post without a server hop.
//
// SECURITY NOTE: this deliberately exposes the Mastodon access token to client
// JS — a conscious tradeoff of the client-fetching refactor (larger XSS blast
// radius in exchange for dropping the server round-trip). The token is the
// user's own and scoped to their account.
export async function GET() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const [mastodon] = await db
      .select({
        handle: connectedAccounts.handle,
        did: connectedAccounts.did,
        instanceUrl: connectedAccounts.instanceUrl,
        accessToken: connectedAccounts.accessToken,
      })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.platform, "mastodon")))
      .limit(1);

    return NextResponse.json({
      mastodon:
        mastodon?.accessToken && mastodon.instanceUrl
          ? {
              handle: mastodon.handle,
              accountId: mastodon.did,
              instanceUrl: mastodon.instanceUrl,
              accessToken: mastodon.accessToken,
            }
          : null,
    });
  } catch (error) {
    console.error("[api/accounts/credentials] error:", error);
    return NextResponse.json({ error: "Failed to load credentials" }, { status: 500 });
  }
}
