import { NextRequest, NextResponse } from "next/server";
import { getNodeOAuthClient } from "@/lib/bluesky-server";

export async function POST(request: NextRequest) {
  try {
    const { handle } = await request.json();
    if (!handle) {
      return NextResponse.json({ error: "Handle is required" }, { status: 400 });
    }

    const trimmedHandle = (handle as string).trim().replace(/^@/, "");
    const client = await getNodeOAuthClient();
    const authUrl = await client.authorize(trimmedHandle, {
      scope: "atproto transition:generic",
    });

    return NextResponse.json({ url: authUrl.toString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Authorization failed";
    console.error("[auth/bluesky/authorize]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
