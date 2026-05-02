import type { Agent } from "@atproto/api";

interface OgMetadata {
  title: string;
  description: string;
  image?: string;
  finalUrl: string;
}

interface BlobRef {
  $type: string;
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface BlueskyLinkCard {
  uri: string;
  title: string;
  description: string;
  thumb?: BlobRef;
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_THUMB_BYTES = 950_000; // Bluesky blob limit is 1MB
const USER_AGENT = "Mozilla/5.0 (compatible; alpaca.blue/1.0; +https://alpaca.blue)";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function matchMeta(html: string, name: string): string | null {
  // Try both attribute orders: property/name first, then content first.
  const escaped = escapeRegex(name);
  const patterns = [
    new RegExp(`<meta[^>]*?(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtml(m[1]).trim();
  }
  return null;
}

function matchTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtml(m[1]).trim() : null;
}

async function fetchOgMetadata(url: string): Promise<OgMetadata | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) return null;

    // Read at most ~256KB — OG tags live in <head>
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const MAX = 256 * 1024;
    while (total < MAX) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      // Stop once we've passed </head>
      const str = new TextDecoder("utf-8", { fatal: false }).decode(value);
      if (str.toLowerCase().includes("</head>")) break;
    }
    reader.cancel().catch(() => {});
    const html = new TextDecoder("utf-8", { fatal: false }).decode(
      Buffer.concat(chunks.map((c) => Buffer.from(c)))
    );

    const title =
      matchMeta(html, "og:title") ||
      matchMeta(html, "twitter:title") ||
      matchTitle(html);
    if (!title) return null;

    const description =
      matchMeta(html, "og:description") ||
      matchMeta(html, "twitter:description") ||
      matchMeta(html, "description") ||
      "";

    const rawImage = matchMeta(html, "og:image") || matchMeta(html, "twitter:image");
    const image = rawImage ? new URL(rawImage, res.url).href : undefined;

    return { title, description, image, finalUrl: res.url };
  } catch {
    return null;
  }
}

async function uploadThumb(agent: Agent, imageUrl: string): Promise<BlobRef | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) return undefined;

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_THUMB_BYTES) return undefined;

    const mimeType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!mimeType.startsWith("image/")) return undefined;

    const { data } = await agent.uploadBlob(buf, { encoding: mimeType });
    return data.blob as unknown as BlobRef;
  } catch {
    return undefined;
  }
}

export async function buildBlueskyLinkCard(agent: Agent, url: string): Promise<BlueskyLinkCard | null> {
  const og = await fetchOgMetadata(url);
  if (!og) return null;

  const thumb = og.image ? await uploadThumb(agent, og.image) : undefined;

  return {
    uri: og.finalUrl,
    title: og.title,
    description: og.description,
    ...(thumb ? { thumb } : {}),
  };
}
