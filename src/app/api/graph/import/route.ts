import { NextRequest, NextResponse } from "next/server";
import { storeBlueskyFollows } from "@/lib/bluesky";
import { importMastodonFollows } from "@/lib/mastodon";

export async function POST(request: NextRequest) {
  try {
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
      const result = await storeBlueskyFollows(follows);
      return NextResponse.json({
        platform: "bluesky",
        imported: result.imported,
      });
    }

    if (platform === "mastodon") {
      const result = await importMastodonFollows();
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
