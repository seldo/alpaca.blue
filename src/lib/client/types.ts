// Shared post shape produced by the client-side fetch pipeline. Structurally
// compatible with the `PostData` that PostCard consumes — keep these fields in
// sync with src/components/PostCard.tsx. This is the client analogue of the
// server's TimelinePost (src/lib/posts.ts); as the refactor proceeds this
// becomes the single canonical shape.

export interface MediaItem {
  type: string;
  url: string;
  alt: string;
  thumbnailUrl?: string;
}

export interface QuotedPost {
  uri: string;
  platform?: string;
  postUrl?: string | null;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  text: string;
  contentHtml?: string;
  media?: MediaItem[];
  postedAt?: string;
}

export interface LinkCard {
  url: string;
  title: string;
  description?: string;
  thumb?: string;
}

export interface CrossPost {
  platform: string;
  postUrl: string | null;
  platformPostId: string;
  platformPostCid: string | null;
  threadRootId: string | null;
  threadRootCid: string | null;
}

export interface ClientPost {
  // Numeric id kept for PostCard compatibility. Client-fetched posts have no DB
  // row, so this is 0 — PostCard treats id <= 0 as "open the platform URL on
  // click" rather than navigating to /posts/[id]. The stable identity is
  // `${platform}:${platformPostId}` (see storeKey).
  id: number;
  platform: string;
  platformPostId: string;
  platformPostCid: string | null;
  postUrl: string | null;
  content: string | null;
  contentHtml: string | null;
  media: MediaItem[] | null;
  replyToId: string | null;
  threadRootId: string | null;
  threadRootCid: string | null;
  repostOfId: string | null;
  quotedPost: QuotedPost | null;
  linkCard: LinkCard | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  viewerLiked: boolean;
  viewerReposted: boolean;
  postedAt: string; // ISO timestamp
  author: {
    id: number;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    platform: string;
    profileUrl: string | null;
    // Set by enrichAuthor when this post is by one of the viewer's own
    // connected accounts. Lets dedup collapse the viewer's cross-posts even
    // before identity resolution links the two accounts to a person.
    isSelf?: boolean;
  } | null;
  person: { id: number; displayName: string | null } | null;
  alsoPostedOn: CrossPost[];
  // Mentions feed only: this is a reply directed at the viewer → PostCard shows
  // a "Replied to you" marker.
  replyToMe?: boolean;
  // Populated by the dedup pass (computed from content). Not rendered.
  dedupeHash: string | null;
}

export function storeKey(platform: string, platformPostId: string): string {
  return `${platform}:${platformPostId}`;
}
