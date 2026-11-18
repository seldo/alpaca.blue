// HTML sanitization for anything rendered with dangerouslySetInnerHTML: post
// bodies, quoted posts, and Mastodon bios. Post HTML comes from other people
// (Bluesky facets/text, Mastodon statuses relayed by the user's instance), and
// this app hands platform tokens to client JS, so a single injected script
// could exfiltrate both accounts' credentials. Every HTML sink goes through
// here, at render time, so posts already cached in IndexedDB are covered too.

import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "a", "p", "br", "span", "strong", "b", "em", "i", "u", "s", "del",
  "code", "pre", "blockquote", "ul", "ol", "li",
];
const ALLOWED_ATTR = ["href", "class", "title", "lang", "translate"];
// Links may only be web or mail links: no javascript:, data:, vbscript:, etc.
const SAFE_URL = /^(?:https?:|mailto:)/i;

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName !== "A") return;
    const href = node.getAttribute("href");
    if (href && !SAFE_URL.test(href.trim())) node.removeAttribute("href");
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  });
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return "";
  // DOMPurify needs a real DOM. Without one (server render) it returns input
  // unchanged, which would be unsafe, so fall back to fully-escaped text.
  if (typeof window === "undefined" || !DOMPurify.isSupported) {
    return escapeText(html.replace(/<[^>]*>/g, " "));
  }
  ensureHooks();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
