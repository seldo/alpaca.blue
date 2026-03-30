import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

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

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const uploadForm = new FormData();
    uploadForm.append("file", file);

    const response = await fetch(`${account.instanceUrl}/api/v1/media`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
      },
      body: uploadForm,
    });

    if (!response.ok || response.status === 202) {
      const text = await response.text();
      console.error("Mastodon media upload failed:", response.status, text);
      return NextResponse.json(
        { error: "Failed to upload media to Mastodon" },
        { status: 502 }
      );
    }

    const media = await response.json();
    return NextResponse.json({ id: media.id });
  } catch (err) {
    console.error("Media upload error:", err);
    return NextResponse.json({ error: "Failed to upload media" }, { status: 500 });
  }
}
