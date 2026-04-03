import { NextRequest, NextResponse } from "next/server";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { requireSession, unauthorizedResponse } from "@/lib/session";

interface BlobRef {
  $type: string;
  ref: { $link: string };
  mimeType: string;
  size: number;
}

interface PostBody {
  text: string;
  replyTo?: { uri: string; cid: string };
  quote?: { uri: string; cid: string };
  images?: { image: BlobRef; alt: string }[];
}

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const body: PostBody = await request.json();
  const { text, replyTo, quote, images } = body;

  if (!text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const agent = await getServerBlueskyAgent(session.userId!);
  if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postParams: Record<string, any> = { text: text.trim() };

  if (replyTo) {
    const ref = { uri: replyTo.uri, cid: replyTo.cid };
    postParams.reply = { root: ref, parent: ref };
  }

  if (images && images.length > 0) {
    postParams.embed = { $type: "app.bsky.embed.images", images };
  } else if (quote) {
    postParams.embed = {
      $type: "app.bsky.embed.record",
      record: { uri: quote.uri, cid: quote.cid },
    };
  }

  const result = await agent.post(postParams);
  return NextResponse.json({ uri: result.uri, cid: result.cid });
}
