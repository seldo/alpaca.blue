import { NextRequest, NextResponse } from "next/server";
import { importBlueskyFollows } from "@/lib/bluesky";
import { importMastodonFollows } from "@/lib/mastodon";

export async function POST(request: NextRequest) {
  try {
    const { platform } = await request.json();

    if (platform === "bluesky") {
      const result = await importBlueskyFollows();
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
    const message =
      error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
