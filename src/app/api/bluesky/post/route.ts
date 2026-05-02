import { NextRequest, NextResponse } from "next/server";
import { RichText } from "@atproto/api";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { buildBlueskyLinkCard } from "@/lib/link-preview";
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
  replyRoot?: { uri: string; cid: string };
  quote?: { uri: string; cid: string };
  images?: { image: BlobRef; alt: string }[];
}

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const body: PostBody = await request.json();
  const { text, replyTo, replyRoot, quote, images } = body;

  if (!text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const agent = await getServerBlueskyAgent(session.userId!);
  if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

  const rt = new RichText({ text: text.trim() });
  await rt.detectFacets(agent);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postParams: Record<string, any> = { text: rt.text, facets: rt.facets };

  if (replyTo) {
    const parentRef = { uri: replyTo.uri, cid: replyTo.cid };
    const rootRef = replyRoot ?? parentRef;
    postParams.reply = { root: rootRef, parent: parentRef };
  }

  if (images && images.length > 0) {
    postParams.embed = { $type: "app.bsky.embed.images", images };
  } else if (quote) {
    postParams.embed = {
      $type: "app.bsky.embed.record",
      record: { uri: quote.uri, cid: quote.cid },
    };
  } else {
    // No images or quote — try to attach a link card for the first URL.
    // Bluesky allows only one embed per post, so this is mutually exclusive.
    let linkUri: string | undefined;
    for (const facet of rt.facets ?? []) {
      for (const feature of facet.features) {
        const f = feature as { $type: string; uri?: string };
        if (f.$type === "app.bsky.richtext.facet#link" && typeof f.uri === "string") {
          linkUri = f.uri;
          break;
        }
      }
      if (linkUri) break;
    }
    if (linkUri) {
      const card = await buildBlueskyLinkCard(agent, linkUri);
      if (card) {
        postParams.embed = { $type: "app.bsky.embed.external", external: card };
      }
    }
  }

  const result = await agent.post(postParams);
  return NextResponse.json({ uri: result.uri, cid: result.cid });
}
