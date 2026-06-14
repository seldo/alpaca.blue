import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { fetchLinkCardMetadata } from "@/lib/link-preview";

// GET ?url= → Open Graph metadata + thumb bytes (base64) for a link card.
// This is the one bit of compose the browser can't do itself — fetching an
// arbitrary URL's HTML/image is blocked by CORS. The client uploads the thumb
// blob and assembles the embed with its own creds.
export async function GET(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const url = request.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  try {
    const card = await fetchLinkCardMetadata(url);
    return NextResponse.json({ card });
  } catch (err) {
    console.error("[api/bluesky/link-card] error:", err);
    return NextResponse.json({ card: null });
  }
}
