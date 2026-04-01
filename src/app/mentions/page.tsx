"use client";

import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from "react";
import {
  getBlueskyAgent,
  setBlueskyAgent,
  restoreBlueskySession,
} from "@/lib/bluesky-oauth";
import { usePullToRefresh } from "@/lib/usePullToRefresh";
import { PostCard } from "@/components/PostCard";
import { ReactionCard } from "@/components/ReactionCard";
import { AppLayout } from "@/components/AppHeader";
import type { RawReaction, ReactionGroup } from "@/lib/reactions";

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
    uri: string;
    authorHandle: string;
    authorDisplayName?: string;
    authorAvatar?: string;
    text: string;
    media?: Array<{ type: string; url: string; alt: string }>;
    postedAt?: string;
  } | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  postedAt: string;
  author: {
    id: number;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    platform: string;
    profileUrl: string | null;
  } | null;
  person: {
    id: number;
    displayName: string | null;
  } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
  replyToMe?: boolean;
  linkCard?: { url: string; title: string; description?: string; thumb?: string } | null;
}

interface BlueskyFacetFeature {
  $type: string;
  uri?: string;
  did?: string;
  tag?: string;
}

interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: BlueskyFacetFeature[];
}

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
  if (!facets || facets.length === 0) {
    return linkifyUrls(escapeHtml(text));
  }

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
      html += `<a href="${escapeAttr(feature.uri)}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else if (feature?.$type === "app.bsky.richtext.facet#mention" && feature.did) {
      html += `<a href="https://bsky.app/profile/${escapeAttr(feature.did)}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else if (feature?.$type === "app.bsky.richtext.facet#tag" && feature.tag) {
      html += `<a href="https://bsky.app/hashtag/${escapeAttr(feature.tag)}" target="_blank" rel="noopener noreferrer">${facetText}</a>`;
    } else {
      html += facetText;
    }
    lastByte = byteEnd;
  }

  html += linkifyUrls(escapeHtml(decoder.decode(bytes.slice(lastByte))));
  return html;
}

function linkifyUrls(escaped: string): string {
  return escaped.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return "status" in err && (err as { status: number }).status === 401;
}

export default function MentionsPage() {
  const [posts, setPosts] = useState<PostData[]>([]);
  const [reactionGroups, setReactionGroups] = useState<ReactionGroup[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);
  const pendingScrollRestore = useRef<number | null>(null);
  const isFetchingRef = useRef(false);

  // Merge posts and reactions into a single sorted feed
  const feed = useMemo(() => {
    type FeedItem = { sortKey: string; kind: "post"; data: PostData } | { sortKey: string; kind: "reaction"; data: ReactionGroup };
    const items: FeedItem[] = [
      ...posts.map((p) => ({ sortKey: p.postedAt, kind: "post" as const, data: p })),
      ...reactionGroups.map((g) => ({ sortKey: g.latestAt, kind: "reaction" as const, data: g })),
    ];
    return items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [posts, reactionGroups]);

  // Initialize Bluesky agent
  useEffect(() => {
    const existing = getBlueskyAgent();
    if (existing) {
      agentRef.current = existing;
      return;
    }

    (async () => {
      const agent = await restoreBlueskySession();
      if (agent) {
        agentRef.current = agent;
      } else {
        setFetchError("Your Bluesky session has expired. Please log out and log back in to reconnect.");
      }
    })();
  }, []);

  const fetchMentionsCursor = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams({ limit: "50", type: "mentions" });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`/api/timeline?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      return data;
    },
    []
  );

  const refreshFeed = useCallback(async () => {
    if (isFetchingRef.current) {
      console.log("[mentions] refreshFeed called while already fetching, skipping");
      return;
    }
    isFetchingRef.current = true;
    sessionStorage.removeItem("mentions_cache");
    sessionStorage.removeItem("mentions_scroll");
    setFetching(true);
    setFetchStatus("Fetching mentions...");
    setFetchError(null);

    try {
      // Fetch Bluesky notifications client-side (needs DPoP agent)
      let blueskyMentionPosts: {
        uri: string; cid: string; authorDid: string; authorHandle: string;
        text: string; contentHtml: string; createdAt: string;
        replyToUri?: string; isMention: boolean;
        images?: Array<{ url: string; alt: string }>;
        quotedPost?: ReturnType<typeof extractQuotedPost>;
      }[] = [];
      const blueskyReactions: RawReaction[] = [];

      const agent = agentRef.current;
      if (agent?.did) {
        try {
          setFetchStatus("Fetching Bluesky notifications...");
          const response = await agent.listNotifications({ limit: 50 });
          const notifications = response.data.notifications as Array<{
            reason: string;
            uri: string;
            cid: string;
            author: { did: string; handle: string; displayName?: string; avatar?: string };
            record: unknown;
            indexedAt: string;
            reasonSubject?: string;
          }>;

          // Split into mentions/replies (stored as posts) vs reactions
          const mentionNotifs = notifications.filter(
            (n) => n.reason === "mention" || n.reason === "reply"
          );
          const reactionNotifs = notifications.filter(
            (n) => n.reason === "like" || n.reason === "repost" || n.reason === "follow" || n.reason === "quote"
          );

          // Hydrate mention posts with embed data
          const mentionUris = mentionNotifs.map((n) => n.uri);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hydratedMap = new Map<string, { embed?: unknown; authorDisplayName?: string; authorAvatar?: string }>();
          if (mentionUris.length > 0) {
            try {
              const postsRes = await agent.getPosts({ uris: mentionUris });
              for (const p of postsRes.data.posts) {
                const hp = p as unknown as { embed?: unknown; author: { displayName?: string; avatar?: string } };
                hydratedMap.set(p.uri, {
                  embed: hp.embed,
                  authorDisplayName: hp.author.displayName || undefined,
                  authorAvatar: hp.author.avatar || undefined,
                });
              }
            } catch (err) {
              console.warn("Failed to batch-fetch post embeds:", err);
            }
          }

          blueskyMentionPosts = mentionNotifs.map((n) => {
            const record = n.record as { text?: string; facets?: BlueskyFacet[]; reply?: { parent?: { uri?: string } } };
            const text = record?.text || "";
            const contentHtml = facetsToHtml(text, record?.facets);
            const hydrated = hydratedMap.get(n.uri);
            return {
              uri: n.uri,
              cid: n.cid,
              authorDid: n.author.did,
              authorHandle: n.author.handle,
              authorDisplayName: hydrated?.authorDisplayName,
              authorAvatar: hydrated?.authorAvatar,
              text,
              contentHtml,
              createdAt: n.indexedAt,
              replyToUri: record?.reply?.parent?.uri || undefined,
              isMention: true,
              images: extractBlueskyImages(hydrated?.embed),
              quotedPost: extractQuotedPost(hydrated?.embed),
            };
          });

          // Batch-fetch subject post text for likes/reposts/quotes
          const subjectUris = [
            ...new Set(
              reactionNotifs
                .filter((n) => n.reasonSubject)
                .map((n) => n.reasonSubject!)
            ),
          ].slice(0, 25); // getPosts max is 25

          const subjectTextMap = new Map<string, string>(); // uri -> text
          const subjectMetaMap = new Map<string, { handle: string; displayName?: string; avatar?: string; postedAt?: string }>(); // uri -> author meta
          if (subjectUris.length > 0) {
            try {
              const subjectsRes = await agent.getPosts({ uris: subjectUris });
              for (const p of subjectsRes.data.posts) {
                const record = (p as unknown as { record: { text?: string } }).record;
                const author = (p as unknown as { author: { handle: string; displayName?: string; avatar?: string } }).author;
                const indexedAt = (p as unknown as { indexedAt?: string }).indexedAt;
                subjectTextMap.set(p.uri, record?.text || "");
                subjectMetaMap.set(p.uri, {
                  handle: author?.handle || "",
                  displayName: author?.displayName,
                  avatar: author?.avatar,
                  postedAt: indexedAt,
                });
              }
            } catch (err) {
              console.warn("Failed to fetch reaction subject posts:", err);
            }
          }

          // Look up internal post IDs for subject URIs
          const subjectInternalIdMap = new Map<string, number>(); // uri -> internal post id
          if (subjectUris.length > 0) {
            await Promise.allSettled(
              subjectUris.map(async (uri) => {
                const meta = subjectMetaMap.get(uri);
                const text = subjectTextMap.get(uri) ?? "";
                try {
                  const res = await fetch("/api/posts/lookup", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      uri,
                      authorHandle: meta?.handle ?? "",
                      authorDisplayName: meta?.displayName,
                      authorAvatar: meta?.avatar,
                      text,
                      postedAt: meta?.postedAt,
                    }),
                  });
                  if (res.ok) {
                    const data = await res.json();
                    if (data.id) subjectInternalIdMap.set(uri, data.id);
                  }
                } catch {
                  // ignore — subjectUrl will be null
                }
              })
            );
          }

          // Map reaction notifications to RawReaction
          for (const n of reactionNotifs) {
            const reactionType =
              n.reason === "like" ? "like" :
              n.reason === "repost" ? "repost" :
              n.reason === "follow" ? "follow" :
              "quote";

            const subjectId = n.reasonSubject ?? null;
            const subjectText = subjectId ? (subjectTextMap.get(subjectId) ?? null) : null;
            const internalId = subjectId ? subjectInternalIdMap.get(subjectId) : undefined;
            const subjectUrl = internalId ? `/posts/${internalId}` : null;

            blueskyReactions.push({
              platform: "bluesky",
              reactionType,
              subjectId,
              subjectExcerpt: subjectText,
              subjectUrl,
              reactor: {
                handle: n.author.handle,
                displayName: n.author.displayName || n.author.handle,
                avatarUrl: n.author.avatar || "",
              },
              reactedAt: n.indexedAt,
            });
          }
        } catch (err) {
          console.error("Bluesky notifications fetch error:", err instanceof Error ? err.message : err);
          if (isAuthError(err)) {
            setBlueskyAgent(null);
            agentRef.current = null;
            setFetchError("Your Bluesky session has expired. Please reload the page to reconnect.");
          } else {
            setFetchError("Bluesky fetch failed — check your connection.");
          }
        }
      }

      // Fetch mentions (stored as posts) + Mastodon reactions in parallel
      setFetchStatus("Fetching mentions and reactions...");
      const [mentionsResult, reactionsResult] = await Promise.allSettled([
        fetch("/api/posts/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: "all", type: "mentions", posts: blueskyMentionPosts }),
        }),
        fetch("/api/reactions/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blueskyReactions }),
        }),
      ]);

      if (mentionsResult.status === "fulfilled" && mentionsResult.value.ok) {
        const data = await mentionsResult.value.json();
        setPosts(data.posts);
        setNextCursor(data.nextCursor);
      } else if (mentionsResult.status === "fulfilled") {
        const status = mentionsResult.value.status;
        if (status === 401) {
          setFetchError("Your Mastodon session has expired. Please reconnect your account.");
        } else {
          console.error("Mentions fetch failed:", status);
        }
      } else {
        console.error("Mentions fetch error:", mentionsResult.reason);
      }

      if (reactionsResult.status === "fulfilled" && reactionsResult.value.ok) {
        const data = await reactionsResult.value.json();
        setReactionGroups(data.reactionGroups || []);
      } else {
        console.error("Reactions fetch failed");
      }
    } catch (err) {
      console.error("Mentions fetch error:", err);
    } finally {
      setFetching(false);
      setFetchStatus("");
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  const { pullDistance, refreshing: pullRefreshing } = usePullToRefresh(refreshFeed, fetching);

  // Cache feed state
  useEffect(() => {
    if (posts.length > 0 || reactionGroups.length > 0) {
      sessionStorage.setItem(
        "mentions_cache",
        JSON.stringify({ posts, reactionGroups, nextCursor })
      );
    }
  }, [posts, reactionGroups, nextCursor]);

  // Save scroll position
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function handleScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        sessionStorage.setItem("mentions_scroll", String(window.scrollY));
      }, 100);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  // Restore from cache or fetch fresh
  useEffect(() => {
    const cached = sessionStorage.getItem("mentions_cache");
    if (cached) {
      try {
        const { posts: cachedPosts, reactionGroups: cachedReactions, nextCursor: cachedCursor } = JSON.parse(cached);
        if (cachedPosts?.length > 0 || cachedReactions?.length > 0) {
          setPosts(cachedPosts || []);
          setReactionGroups(cachedReactions || []);
          setNextCursor(cachedCursor);
          setLoading(false);
          const savedScroll = sessionStorage.getItem("mentions_scroll");
          if (savedScroll) {
            pendingScrollRestore.current = parseInt(savedScroll);
          }
          return;
        }
      } catch {
        // Fall through
      }
    }
    const timer = setTimeout(refreshFeed, 500);
    return () => clearTimeout(timer);
  }, [refreshFeed]);

  useLayoutEffect(() => {
    if (pendingScrollRestore.current !== null && feed.length > 0) {
      window.scrollTo(0, pendingScrollRestore.current);
      pendingScrollRestore.current = null;
    }
  }, [feed]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchMentionsCursor(nextCursor);
      setPosts((prev) => [...prev, ...data.posts]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      console.error("Load more error:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppLayout>

      {(pullDistance > 0 || pullRefreshing) && (
        <div className="pull-indicator" style={{ height: pullRefreshing ? 48 : pullDistance * 0.5 }}>
          <div className="spinner" style={{ opacity: pullRefreshing ? 1 : pullDistance > 0 ? 0.4 + 0.6 * (pullDistance / 72) : 0 }} />
        </div>
      )}

      {fetching && fetchStatus && (
        <p className="text-muted" style={{ textAlign: "center", padding: "4px 0", fontSize: "0.85em" }}>{fetchStatus}</p>
      )}

      {fetchError && (
        <p className="text-muted" style={{ textAlign: "center", padding: "8px 0", color: "var(--color-error, #c0392b)" }}>
          {fetchError}{" "}
          {fetchError.includes("expired") && <button onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}>Log out</button>}
        </p>
      )}

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && feed.length === 0 && (
        <p className="text-muted" style={{ textAlign: "center", padding: "40px 0" }}>
          No mentions or reactions yet. Pull down to refresh.
        </p>
      )}

      {!loading && (
        <div className="timeline-feed">
          {feed.map((item) =>
            item.kind === "reaction" ? (
              <ReactionCard key={item.data.id} group={item.data} />
            ) : (
              <PostCard
                key={`${item.data.platform}-${item.data.id}`}
                post={item.data}
                blueskyAgent={agentRef.current}
              />
            )
          )}

          {nextCursor && (
            <div className="load-more">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="btn btn-outline load-more-btn"
              >
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </AppLayout>
  );
}
