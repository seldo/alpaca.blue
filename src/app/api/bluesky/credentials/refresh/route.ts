import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { getBrokeredBlueskyCredentials } from "@/lib/bluesky-server";

// Forces a token refresh and returns fresh credentials. The browser calls this
// when a direct PDS request returns 401 (expired access token). Refresh is
// serialized server-side by the distributed Redis lock, so two tabs/devices
// hitting this at once can't double-spend Bluesky's one-time refresh token.
export async function POST() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();

    const creds = await getBrokeredBlueskyCredentials(session.userId!, { refresh: true });
    if (!creds) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }
    return NextResponse.json({ bluesky: creds });
  } catch (error) {
    console.error("[api/bluesky/credentials/refresh] error:", error);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
