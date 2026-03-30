"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getBlueskyAgent, restoreBlueskySession } from "@/lib/bluesky-oauth";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";

interface UserInfo {
  blueskyHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface Account {
  platform: string;
  handle: string;
}

interface PostData {
  id: number;
  platform: string;
  platformPostId: string;
  platformPostCid?: string | null;
  postUrl: string | null;
  content: string | null;
  contentHtml: string | null;
  media: Array<{ type: string; url: string; alt: string }> | null;
  replyToId: string | null;
  repostOfId: string | null;
  quotedPost: {
    uri: string; authorHandle: string; authorDisplayName?: string;
    authorAvatar?: string; text: string;
    media?: Array<{ type: string; url: string; alt: string }>; postedAt?: string;
  } | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: { id: number; handle: string; displayName: string | null; avatarUrl: string | null; platform: string; profileUrl: string | null } | null;
  person: { id: number; displayName: string | null } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
  replyToAuthor: { handle: string; dbPostId: number; postUrl: string | null } | null;
}

interface BlueskyFacetFeature { $type: string; uri?: string; did?: string; tag?: string; }
interface BlueskyFacet { index: { byteStart: number; byteEnd: number }; features: BlueskyFacetFeature[]; }
interface BlueskyImage { thumb: string; alt: string; fullsize: string; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBlueskyImages(embed: any): Array<{ url: string; alt: string }> {
  if (!embed) return [];
  const images: Array<{ url: string; alt: string }> = [];
  if (embed.images && Array.isArray(embed.images)) {
    for (const img of embed.images as BlueskyImage[]) {
      images.push({ url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }
  if (embed.media?.images && Array.isArray(embed.media.images)) {
    for (const img of embed.media.images as BlueskyImage[]) {
      images.push({ url: img.fullsize || img.thumb, alt: img.alt || "" });
    }
  }
  if (embed.playlist && embed.thumbnail) {
    images.push({ url: embed.thumbnail, alt: "Video thumbnail" });
  }
  if (embed.media?.playlist && embed.media?.thumbnail) {
    images.push({ url: embed.media.thumbnail, alt: "Video thumbnail" });
  }
  if (embed.external?.thumb) {
    images.push({ url: embed.external.thumb, alt: embed.external.title || "" });
  }
  return images;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractQuotedPost(embed: any): {
  uri: string; authorHandle: string; authorDisplayName?: string;
  authorAvatar?: string; text: string;
  media?: Array<{ type: string; url: string; alt: string }>; postedAt?: string;
} | undefined {
  if (!embed) return undefined;
  const record = embed.record?.record ?? embed.record;
  if (!record?.author || !record?.value) return undefined;
  if (record.$type && !record.$type.includes("viewRecord")) return undefined;
  const quoted: { uri: string; authorHandle: string; authorDisplayName?: string; authorAvatar?: string; text: string; media?: Array<{ type: string; url: string; alt: string }>; postedAt?: string; } = {
    uri: record.uri,
    authorHandle: record.author.handle,
    authorDisplayName: record.author.displayName || undefined,
    authorAvatar: record.author.avatar || undefined,
    text: (record.value as { text?: string })?.text || "",
    postedAt: record.indexedAt || (record.value as { createdAt?: string })?.createdAt,
  };
  if (record.embeds && Array.isArray(record.embeds) && record.embeds.length > 0) {
    const embeddedImages = extractBlueskyImages(record.embeds[0]);
    if (embeddedImages.length > 0) {
      quoted.media = embeddedImages.map((img) => ({ type: "image", url: img.url, alt: img.alt }));
    }
  }
  return quoted;
}

function facetsToHtml(text: string, facets?: BlueskyFacet[]): string {
  if (!facets || facets.length === 0) return linkifyUrls(escapeHtml(text));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);
  const sorted = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart);
  let html = "";
  let lastByte = 0;
  for (const facet of sorted) {
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < lastByte || byteEnd > bytes.length) continue;
    html += linkifyUrls(escapeHtml(decoder.decode(bytes.slice(lastByte, byteStart))));
    const facetText = escapeHtml(decoder.decode(bytes.slice(byteStart, byteEnd)));
    const feature = facet.features[0];
    if (feature?.$type === "app.bsky.richtext.facet#link" && feature.uri) {
      html += `<a href="${feature.uri}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else if (feature?.$type === "app.bsky.richtext.facet#mention" && feature.did) {
      html += `<a href="https://bsky.app/profile/${feature.did}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else {
      html += facetText;
    }
    lastByte = byteEnd;
  }
  html += linkifyUrls(escapeHtml(decoder.decode(bytes.slice(lastByte))));
  return html;
}

function linkifyUrls(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<&]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function ProfilePage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetching, setFetching] = useState(false);
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);
  const isFetchingRef = useRef(false);

  const refreshPosts = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setFetching(true);

    try {
      let blueskyPosts: unknown[] = [];
      const agent = agentRef.current;
      if (agent?.did) {
        try {
          const response = await agent.getAuthorFeed({ actor: agent.did, limit: 50 });
          blueskyPosts = response.data.feed.map((item) => {
            const post = item.post as {
              uri: string; cid: string;
              author: { did: string; handle: string };
              record: { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string } } };
              indexedAt: string;
              likeCount?: number; repostCount?: number; replyCount?: number;
              embed?: unknown;
            };
            const text = post.record?.text || "";
            return {
              uri: post.uri, cid: post.cid,
              authorDid: post.author.did, authorHandle: post.author.handle,
              text, contentHtml: facetsToHtml(text, post.record?.facets),
              createdAt: post.indexedAt,
              likeCount: post.likeCount, repostCount: post.repostCount, replyCount: post.replyCount,
              replyToUri: post.record?.reply?.parent?.uri || undefined,
              images: extractBlueskyImages(post.embed),
              quotedPost: extractQuotedPost(post.embed),
            };
          });
        } catch (err) {
          console.error("Bluesky own feed error:", err);
        }
      }

      const res = await fetch("/api/profile/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posts: blueskyPosts }),
      });
      if (res.ok) {
        const data = await res.json();
        setPosts(data.posts);
        setNextCursor(data.nextCursor);
      }
    } catch (err) {
      console.error("Profile refresh error:", err);
    } finally {
      setFetching(false);
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    async function init() {
      let agent = getBlueskyAgent();
      if (!agent) agent = await restoreBlueskySession();
      if (agent) agentRef.current = agent;

      Promise.all([
        fetch("/api/auth/me").then((r) => r.json()),
        fetch("/api/accounts").then((r) => r.json()),
      ]).then(([me, accts]) => {
        setUser(me);
        setAccounts(accts);
      }).catch(() => {});

      refreshPosts();
    }
    init();
  }, [refreshPosts]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/profile/posts?cursor=${nextCursor}&limit=50`);
      const data = await res.json();
      setPosts((prev) => [...prev, ...data.posts]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Load more error:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppLayout blueskyAgent={agentRef.current}>
      <div className="profile-header">
        {user?.avatarUrl && (
          <img src={user.avatarUrl} alt="" className="profile-avatar" />
        )}
        <div className="profile-info">
          <h1 className="profile-displayname">{user?.displayName || user?.blueskyHandle}</h1>
          <div className="profile-accounts">
            {accounts.map((a) => (
              <span key={`${a.platform}-${a.handle}`} className="profile-account-chip">
                <span className={`platform-badge ${a.platform}`}>
                  {a.platform === "bluesky" ? "B" : "M"}
                </span>
                <span className="profile-account-handle">{a.handle}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {(loading || fetching) && (
        <div className="spinner-container"><div className="spinner" /></div>
      )}

      {!loading && posts.length === 0 && !fetching && (
        <p className="text-muted" style={{ textAlign: "center", padding: "40px 0" }}>
          No posts yet.
        </p>
      )}

      {!loading && (
        <div className="timeline-feed">
          {posts.map((post) => (
            <PostCard key={`${post.platform}-${post.id}`} post={post} blueskyAgent={agentRef.current} />
          ))}
          {nextCursor && (
            <div className="load-more">
              <button onClick={loadMore} disabled={loadingMore} className="btn btn-outline load-more-btn">
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </AppLayout>
  );
}
