import { NextRequest, NextResponse } from "next/server";
import { storeBlueskyFollows } from "@/lib/bluesky";
import { importMastodonFollows } from "@/lib/mastodon";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const body = await request.json();
    const { platform } = body;

    if (platform === "bluesky") {
      const { follows } = body;
      if (!follows || !Array.isArray(follows)) {
        return NextResponse.json(
          { error: "follows array is required for Bluesky import" },
          { status: 400 }
        );
      }
      const result = await storeBlueskyFollows(follows, userId);
      return NextResponse.json({
        platform: "bluesky",
        imported: result.imported,
      });
    }

    if (platform === "mastodon") {
      const result = await importMastodonFollows(userId);
      return NextResponse.json({
        platform: "mastodon",
        imported: result.imported,
      });
    }

    return NextResponse.json(
      { error: "Invalid platform. Use 'bluesky' or 'mastodon'." },
      { status: 400 }
    );
  } catch (error) {
    console.error("Import error:", error);
    const message =
      error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
