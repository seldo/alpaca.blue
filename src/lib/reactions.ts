// ── Types ───────────────────────────────────────────────────

export type ReactionType = "like" | "repost" | "follow" | "quote";

export interface Reactor {
  handle: string;
  did?: string | null; // Bluesky DID, when known — used for lookup/create on click
  displayName?: string;
  avatarUrl?: string;
  platformIdentityId?: number | null;
  personId?: number | null;
}

export interface RawReaction {
  platform: "bluesky" | "mastodon";
  reactionType: ReactionType;
  subjectId: string | null;      // URI/ID of the post that was liked/reposted; null for follows
  subjectExcerpt: string | null; // first ~80 chars of subject post text
  subjectUrl: string | null;
  reactor: Reactor;
  reactedAt: string;             // ISO timestamp
}

export interface ReactionGroup {
  _type: "reaction";              // discriminator for union with PostData
  id: string;                     // stable key for React
  platform: "bluesky" | "mastodon" | "both";
  reactionType: ReactionType;
  subjectId: string | null;
  subjectExcerpt: string | null;
  subjectUrl: string | null;
  reactors: Reactor[];
  latestAt: string;
  count: number;
}

// ── Grouping ─────────────────────────────────────────────────

export function groupReactions(rawReactions: RawReaction[]): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();

  for (const r of rawReactions) {
    // Follows are grouped together across platforms; everything else by (platform, type, subjectId)
    const key =
      r.reactionType === "follow"
        ? "follow"
        : `${r.platform}:${r.reactionType}:${r.subjectId}`;

    if (!groups.has(key)) {
      groups.set(key, {
        _type: "reaction",
        id: key,
        platform: r.platform,
        reactionType: r.reactionType,
        subjectId: r.subjectId,
        subjectExcerpt: r.subjectExcerpt,
        subjectUrl: r.subjectUrl,
        reactors: [],
        latestAt: r.reactedAt,
        count: 0,
      });
    }

    const group = groups.get(key)!;
    group.reactors.push(r.reactor);
    group.count++;
    if (r.reactedAt > group.latestAt) group.latestAt = r.reactedAt;

    // Mark as cross-platform if reactions come from both sides
    if (group.platform !== r.platform && group.platform !== "both") {
      group.platform = "both";
    }

    // Fill in subject info from the first reaction that has it
    if (!group.subjectExcerpt && r.subjectExcerpt) {
      group.subjectExcerpt = r.subjectExcerpt;
    }
    if (!group.subjectUrl && r.subjectUrl) {
      group.subjectUrl = r.subjectUrl;
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    b.latestAt.localeCompare(a.latestAt)
  );
}
