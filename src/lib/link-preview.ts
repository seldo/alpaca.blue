interface OgMetadata {
  title: string;
  description: string;
  image?: string;
  finalUrl: string;
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

// Returns OG metadata + the raw thumb bytes (base64). The browser fetches this
// (the URL fetch is CORS-bound, so it must happen server-side), then uploads the
// thumb itself via its own DPoP creds and assembles the external embed.
export interface LinkCardMetadata {
  url: string;
  title: string;
  description: string;
  thumb?: { base64: string; mimeType: string };
}

async function fetchThumbBytes(
  imageUrl: string,
): Promise<{ base64: string; mimeType: string } | undefined> {
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
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_THUMB_BYTES) return undefined;
    const mimeType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!mimeType.startsWith("image/")) return undefined;
    return { base64: buf.toString("base64"), mimeType };
  } catch {
    return undefined;
  }
}

export async function fetchLinkCardMetadata(url: string): Promise<LinkCardMetadata | null> {
  const og = await fetchOgMetadata(url);
  if (!og) return null;
  const thumb = og.image ? await fetchThumbBytes(og.image) : undefined;
  return {
    url: og.finalUrl,
    title: og.title,
    description: og.description,
    ...(thumb ? { thumb } : {}),
  };
}
