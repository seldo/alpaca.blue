// platform_identities.raw_profile is declared as drizzle `json()` but lands
// as `LONGTEXT` in MariaDB, so mysql2 returns it as a string on read. (The
// in-memory copy returned by refreshIdentityProfile is the parsed agent
// response — already an object.) Accept either.
export function parseRawProfile(rawProfile: unknown): Record<string, unknown> | null {
  if (!rawProfile) return null;
  if (typeof rawProfile === "object") return rawProfile as Record<string, unknown>;
  if (typeof rawProfile === "string") {
    try {
      const parsed = JSON.parse(rawProfile);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Extracts the banner / header image URL from a stored rawProfile JSON
// blob. Bluesky's `app.bsky.actor.defs#profileViewDetailed` puts it under
// `banner`; Mastodon's account entity uses `header`. Returns null when
// rawProfile is missing or doesn't contain a usable URL — Bluesky's
// `getFollows` returns the basic profile shape (no banner), so most
// followed Bluesky identities will return null until they're refreshed
// via getProfile.
export function extractBannerUrl(
  platform: string,
  rawProfile: unknown
): string | null {
  const r = parseRawProfile(rawProfile);
  if (!r) return null;
  const candidate =
    platform === "bluesky"
      ? r.banner
      : platform === "mastodon"
      ? r.header
      : null;
  if (typeof candidate !== "string") return null;
  // Mastodon serves a placeholder PNG for users with no header set.
  if (candidate.endsWith("/headers/original/missing.png")) return null;
  return candidate || null;
}

export interface IdentityStats {
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
}

export function extractStats(
  platform: string,
  rawProfile: unknown
): IdentityStats {
  const empty: IdentityStats = { followersCount: null, followingCount: null, postsCount: null };
  const r = parseRawProfile(rawProfile);
  if (!r) return empty;
  if (platform === "bluesky") {
    return {
      followersCount: typeof r.followersCount === "number" ? r.followersCount : null,
      followingCount: typeof r.followsCount === "number" ? r.followsCount : null,
      postsCount: typeof r.postsCount === "number" ? r.postsCount : null,
    };
  }
  if (platform === "mastodon") {
    return {
      followersCount: typeof r.followers_count === "number" ? r.followers_count : null,
      followingCount: typeof r.following_count === "number" ? r.following_count : null,
      postsCount: typeof r.statuses_count === "number" ? r.statuses_count : null,
    };
  }
  return empty;
}

// Bluesky stores the user's follow record URI under viewer.following — its
// presence means "I follow this account." We need that URI later to delete
// the follow. Mastodon doesn't put relationship data in the account entity,
// so the caller fills isFollowing in from a separate /relationships call.
export function extractBlueskyFollowUri(rawProfile: unknown): string | null {
  const r = parseRawProfile(rawProfile);
  if (!r) return null;
  const viewer = r.viewer;
  if (!viewer || typeof viewer !== "object") return null;
  const v = viewer as Record<string, unknown>;
  return typeof v.following === "string" ? v.following : null;
}

// Linkifies a plain-text Bluesky bio. URLs become anchor tags; everything
// else is HTML-escaped so it can be set via dangerouslySetInnerHTML alongside
// pre-rendered Mastodon HTML bios. Newlines are preserved as <br>.
export function bioToHtml(platform: string, bio: string | null): string | null {
  if (!bio) return null;
  if (platform === "mastodon") return bio; // already HTML
  const escaped = bio
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const linkified = escaped.replace(
    /(https?:\/\/[^\s<]+[^\s<.,!?;:)(\]])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return linkified.replace(/\n/g, "<br>");
}
