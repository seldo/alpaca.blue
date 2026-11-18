import { safeFetch } from "./safe-fetch";

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
    // Read at most ~256KB, stopping at </head> — OG tags live in <head>.
    const res = await safeFetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: 256 * 1024,
      stopAt: "</head>",
    });
    if (!res || res.status < 200 || res.status >= 300) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) return null;

    const html = new TextDecoder("utf-8", { fatal: false }).decode(res.body);
    const finalUrl = res.url;

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
    const image = rawImage ? new URL(rawImage, finalUrl).href : undefined;

    return { title, description, image, finalUrl };
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
    const res = await safeFetch(imageUrl, {
      headers: { "User-Agent": USER_AGENT },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_THUMB_BYTES,
      rejectOversize: true, // a truncated image is useless
    });
    if (!res || res.status < 200 || res.status >= 300) return undefined;
    const buf = res.body;
    if (buf.length === 0) return undefined;
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
