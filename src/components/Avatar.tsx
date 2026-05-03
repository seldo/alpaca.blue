"use client";

import { useState, useCallback } from "react";

interface AvatarProps {
  identityId?: number | null;
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}

// Renders an identity avatar. If the underlying CDN URL 404s (Bluesky and
// Mastodon both rotate avatar URLs), POST to /api/identities/{id}/refresh
// to pull a fresh URL from the platform and swap it in. Only retries once
// per src to avoid loops.
export function Avatar({ identityId, src, alt = "", className, style }: AvatarProps) {
  const [currentSrc, setCurrentSrc] = useState(src);
  const [retried, setRetried] = useState(false);
  const [prevSrc, setPrevSrc] = useState(src);

  // Reset internal state when the parent passes a different src.
  // See https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (src !== prevSrc) {
    setPrevSrc(src);
    setCurrentSrc(src);
    setRetried(false);
  }

  const handleError = useCallback(async () => {
    if (retried || !identityId) return;
    setRetried(true);
    try {
      const res = await fetch(`/api/identities/${identityId}/refresh`, { method: "POST" });
      if (!res.ok) return;
      const data = (await res.json()) as { avatarUrl: string | null };
      if (data.avatarUrl && data.avatarUrl !== currentSrc) {
        setCurrentSrc(data.avatarUrl);
      }
    } catch {
      // swallow — keep showing the broken icon
    }
  }, [identityId, retried, currentSrc]);

  return <img src={currentSrc} alt={alt} className={className} style={style} onError={handleError} />;
}
