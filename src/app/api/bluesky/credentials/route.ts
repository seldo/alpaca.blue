import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { getBrokeredBlueskyCredentials } from "@/lib/bluesky-server";

// Hands the browser the credentials it needs to call the user's PDS directly:
// the access token, the DPoP private key (to sign per-request proofs), and the
// PDS URL. See bluesky-server.ts for the ownership split rationale.
//
// SECURITY NOTE: this exposes the access token + DPoP key to client JS — the
// accepted tradeoff of client-side fetching. The refresh token stays
// server-side and never leaves.
export async function GET() {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();

    const creds = await getBrokeredBlueskyCredentials(session.userId!);
    return NextResponse.json({ bluesky: creds });
  } catch (error) {
    console.error("[api/bluesky/credentials] error:", error);
    return NextResponse.json({ error: "Failed to load credentials" }, { status: 500 });
  }
}
