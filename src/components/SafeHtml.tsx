"use client";

import { useSyncExternalStore } from "react";
import { sanitizeHtml } from "@/lib/client/sanitize";

const subscribe = () => () => {};

// Renders untrusted HTML (post bodies, quoted posts, Mastodon bios) after
// sanitizing it. This is the only way such HTML should reach the DOM.
//
// Sanitizing needs a real DOM, so the server render and the hydration pass
// emit an empty element, and the sanitized HTML is filled in on the client
// right after. Rendering it during SSR would produce HTML the client can't
// match, and React doesn't patch innerHTML mismatches.
export function SafeHtml({ html, className }: { html: string | null | undefined; className?: string }) {
  const isClient = useSyncExternalStore(subscribe, () => true, () => false);
  if (!isClient) return <div className={className} />;
  return <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}
