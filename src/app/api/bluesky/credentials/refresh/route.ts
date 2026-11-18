import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { getBrokeredBlueskyCredentials } from "@/lib/bluesky-server";

// Refreshes the token (if the browser's is still current) and returns fresh
// credentials. The browser calls this when a direct PDS request returns 401
// (expired access token). Serialized server-side by distributed Redis locks,
// so two tabs/devices hitting this at once rotate the token only once and
// can't double-spend Bluesky's one-time refresh token.
export async function POST(request: Request) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();

    // The token that just 401'd. If it's no longer the stored one, the server
    // returns the current token without rotating again (see bluesky-server).
    const body = await request.json().catch(() => null);
    const staleToken = typeof body?.staleToken === "string" ? body.staleToken : undefined;

    const creds = await getBrokeredBlueskyCredentials(session.userId!, { refresh: true, staleToken });
    if (!creds) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }
    return NextResponse.json({ bluesky: creds });
  } catch (error) {
    console.error("[api/bluesky/credentials/refresh] error:", error);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
