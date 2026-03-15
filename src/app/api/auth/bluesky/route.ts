import { NextRequest, NextResponse } from "next/server";
import { authenticateBluesky } from "@/lib/bluesky";

export async function POST(request: NextRequest) {
  try {
    const { handle, appPassword } = await request.json();

    if (!handle || !appPassword) {
      return NextResponse.json(
        { error: "Handle and app password are required" },
        { status: 400 }
      );
    }

    const result = await authenticateBluesky(handle, appPassword);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authentication failed";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
