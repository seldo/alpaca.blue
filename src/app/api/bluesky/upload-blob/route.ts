import { NextRequest, NextResponse } from "next/server";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const agent = await getServerBlueskyAgent(session.userId!);
  if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

  const arrayBuffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  const { data } = await agent.uploadBlob(uint8, { encoding: file.type });

  return NextResponse.json({ blob: data.blob });
}
