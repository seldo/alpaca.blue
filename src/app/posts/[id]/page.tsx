"use client";

// Post detail + thread. Two routing forms:
//   • numeric id  → legacy server-backed post (still produced by server pages
//     like /profile); fetched via /api/posts/[id] + /thread.
//   • "<platform>:<platformPostId>" (URL-encoded) → client pipeline; the post +
//     thread are fetched directly from the platform in the browser.
// PostCard pushes the URI form for client posts (id <= 0).

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";
import { BlueskyClient } from "@/lib/client/bluesky";
import { getMastodonCredentials, fetchMastodonThread, type MastodonCredentials } from "@/lib/client/mastodon";
import { getIdentityMap, enrichAuthor } from "@/lib/client/identities";
import { likePost, repostPost } from "@/lib/client/actions";
import { ClientActionsContext, type ClientActions } from "@/lib/client/ClientActionsContext";
import type { ClientPost } from "@/lib/client/types";

export default function PostPage() {
  const params = useParams();
  const router = useRouter();
  const idParam = decodeURIComponent(params.id as string);

  const [post, setPost] = useState<ClientPost | null>(null);
  const [ancestors, setAncestors] = useState<ClientPost[]>([]);
  const [replies, setReplies] = useState<ClientPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bluesky = useRef<BlueskyClient | null>(null);
  const masto = useRef<MastodonCredentials | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // key = "<platform>:<platformPostId>" — split on the first colon only
      // (Bluesky AT URIs contain colons).
      const sep = idParam.indexOf(":");
      const platform = idParam.slice(0, sep);
      const platformPostId = idParam.slice(sep + 1);

      masto.current = await getMastodonCredentials();
      bluesky.current = await BlueskyClient.create();

      let result: { ancestors: ClientPost[]; main: ClientPost | null; replies: ClientPost[] };
      if (platform === "bluesky") {
        if (!bluesky.current) throw new Error("Bluesky session not found");
        result = await bluesky.current.getPostThread(platformPostId);
      } else if (platform === "mastodon") {
        if (!masto.current) throw new Error("Mastodon not connected");
        result = await fetchMastodonThread(masto.current, platformPostId);
      } else {
        throw new Error("Unknown post");
      }
      if (!result.main) throw new Error("Post not found");

      const map = await getIdentityMap();
      for (const p of [result.main, ...result.ancestors, ...result.replies]) enrichAuthor(p, map);
      setPost(result.main);
      setAncestors(result.ancestors);
      setReplies(result.replies);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load post");
    } finally {
      setLoading(false);
    }
  }, [idParam]);

  useEffect(() => { load(); }, [load]);

  const actions: ClientActions = {
    like: (p) => likePost(p, { bluesky: bluesky.current, mastodon: masto.current }),
    repost: (p) => repostPost(p, { bluesky: bluesky.current, mastodon: masto.current }),
  };

  return (
    <AppLayout>
      <button className="back-btn" onClick={() => router.back()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back
      </button>

      {loading && <div className="spinner-container"><div className="spinner" /></div>}

      {error && (
        <p className="error" style={{ textAlign: "center", padding: "40px 0" }}>{error}</p>
      )}

      {post && (
        <ClientActionsContext.Provider value={actions}>
          <div className="thread-view">
            {ancestors.map((ancestor) => (
              <div key={`${ancestor.platform}-${ancestor.platformPostId}`} className="thread-ancestor-node">
                <PostCard post={ancestor} />
              </div>
            ))}

            <div className="thread-focal-node">
              <PostCard post={post} />
            </div>

            {replies.length > 0 && (
              <>
                <div className="thread-replies-label">Replies</div>
                {replies.map((reply) => (
                  <PostCard key={`${reply.platform}-${reply.platformPostId}`} post={reply} />
                ))}
              </>
            )}

            {replies.length === 0 && ancestors.length === 0 && (
              <p className="thread-empty">No replies yet.</p>
            )}
          </div>
        </ClientActionsContext.Provider>
      )}
    </AppLayout>
  );
}
