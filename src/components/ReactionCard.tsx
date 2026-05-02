"use client";

import { useRouter } from "next/navigation";
import type { ReactionGroup, Reactor } from "@/lib/reactions";

function reactorProfileUrl(reactor: Reactor, platform: ReactionGroup["platform"]): string | null {
  // Mastodon handles look like "@user@instance" or "user@instance".
  // Everything else is treated as a Bluesky handle.
  const isMastodon =
    platform === "mastodon" || (platform === "both" && reactor.handle.includes("@"));
  if (isMastodon) {
    const m = reactor.handle.match(/^@?([^@]+)@(.+)$/);
    if (!m) return null;
    return `https://${m[2]}/@${m[1]}`;
  }
  const handle = reactor.handle.replace(/^@/, "");
  return `https://bsky.app/profile/${handle}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function reactorLabel(group: ReactionGroup): string {
  const names = group.reactors
    .slice(0, 2)
    .map((r) => r.displayName || r.handle);

  const extra = group.count - names.length;
  let who: string;
  if (extra > 0) {
    who = `${names.join(", ")}, and ${extra} other${extra === 1 ? "" : "s"}`;
  } else {
    who = names.join(" and ");
  }

  switch (group.reactionType) {
    case "like":    return `${who} liked your post`;
    case "repost":  return `${who} reposted your post`;
    case "follow":  return `${who} followed you`;
    case "quote":   return `${who} quoted your post`;
  }
}

function ReactionIcon({ type }: { type: ReactionGroup["reactionType"] }) {
  switch (type) {
    case "like":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      );
    case "repost":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="17 1 21 5 17 9" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 23 3 19 7 15" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
      );
    case "follow":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <line x1="19" y1="8" x2="19" y2="14" />
          <line x1="22" y1="11" x2="16" y2="11" />
        </svg>
      );
    case "quote":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
          <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
        </svg>
      );
  }
}

const ICON_COLORS: Record<ReactionGroup["reactionType"], string> = {
  like:   "var(--color-error, #e74c3c)",
  repost: "var(--color-primary, #4a90d9)",
  follow: "var(--color-success, #27ae60)",
  quote:  "var(--color-text-muted, #888)",
};

export function ReactionCard({ group }: { group: ReactionGroup }) {
  const router = useRouter();

  const content = (
    <div className="reaction-card">
      <div className="reaction-card-header">
        <div className="reaction-card-top-row">
          <span className="reaction-card-icon" style={{ color: ICON_COLORS[group.reactionType] }}>
            <ReactionIcon type={group.reactionType} />
          </span>
          <span className={`platform-badge ${group.platform === "both" ? "bluesky" : group.platform}`} title={group.platform === "both" ? "Bluesky & Mastodon" : group.platform === "bluesky" ? "Bluesky" : "Mastodon"}>
            {group.platform === "mastodon" ? "M" : "B"}
          </span>
          <div className="reaction-card-avatars">
            {group.reactors.slice(0, 5).map((r, i) => {
              const profileUrl = reactorProfileUrl(r, group.platform);
              const img = r.avatarUrl ? (
                <img src={r.avatarUrl} alt={r.displayName || r.handle} className="reaction-card-avatar" />
              ) : (
                <div className="reaction-card-avatar reaction-card-avatar-placeholder" />
              );
              return profileUrl ? (
                <a
                  key={i}
                  href={profileUrl}
                  onClick={(e) => e.stopPropagation()}
                  title={r.displayName || r.handle}
                >
                  {img}
                </a>
              ) : (
                <span key={i}>{img}</span>
              );
            })}
          </div>
          <span className="reaction-card-time">{relativeTime(group.latestAt)}</span>
        </div>
        <span className="reaction-card-label">{reactorLabel(group)}</span>
      </div>
      {group.subjectExcerpt && (
        <div className="reaction-card-subject">{group.subjectExcerpt}</div>
      )}
    </div>
  );

  if (group.subjectUrl) {
    const subjectUrl = group.subjectUrl;
    const isInternal = subjectUrl.startsWith("/");
    function handleClick(e: React.MouseEvent) {
      const target = e.target as HTMLElement;
      // Let nested links and images handle their own clicks.
      if (target.closest("a") || target.tagName === "IMG") return;
      if (isInternal) router.push(subjectUrl);
      else window.open(subjectUrl, "_blank", "noopener,noreferrer");
    }
    return (
      <div className="reaction-card-link reaction-card-clickable" onClick={handleClick}>
        {content}
      </div>
    );
  }

  return content;
}
