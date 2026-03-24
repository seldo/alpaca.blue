"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getBlueskyOAuthClient,
  getBlueskyAgent,
  setBlueskyAgent,
} from "@/lib/bluesky-oauth";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";

interface Identity {
  id: number;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
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
  person: { id: number; displayName: string | null } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
}

export default function PersonPage() {
  const params = useParams();
  const router = useRouter();
  const personId = params.id as string;

  const [personName, setPersonName] = useState<string>("");
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);

  useEffect(() => {
    const existing = getBlueskyAgent();
    if (existing) {
      agentRef.current = existing;
      return;
    }
    (async () => {
      try {
        const client = await getBlueskyOAuthClient();
        const result = await client.init();
        if (result?.session) {
          const { Agent } = await import("@atproto/api");
          const agent = new Agent(result.session);
          agentRef.current = agent;
          setBlueskyAgent(agent);
        }
      } catch {
        // No Bluesky session
      }
    })();
  }, []);

  const fetchData = useCallback(async () => {
    try {
      // Fetch person info
      const identRes = await fetch("/api/graph/identities");
      const identData = await identRes.json();
      const person = identData.persons?.find(
        (p: { id: number }) => p.id === parseInt(personId)
      );
      if (person) {
        setPersonName(person.displayName || "Unknown");
        setIdentities(person.identities || []);
      }

      // Fetch their posts
      const postsRes = await fetch(`/api/persons/${personId}/posts?limit=50`);
      const postsData = await postsRes.json();
      if (postsData.posts) {
        setPosts(postsData.posts);
        setNextCursor(postsData.nextCursor);
      }
    } catch (err) {
      console.error("Failed to load person:", err);
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/persons/${personId}/posts?limit=50&cursor=${nextCursor}`
      );
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
    <AppLayout>
      <button className="back-btn" onClick={() => router.back()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back
      </button>

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && (
        <>
          {identities.length > 0 && (
            <section className="section">
              <h2 className="section-title">Accounts</h2>
              <div className="person-identities-list">
                {identities.map((i) => (
                  <div key={i.id} className="person-identity-row">
                    {i.avatarUrl && (
                      <img
                        src={i.avatarUrl}
                        alt=""
                        className="person-identity-avatar"
                      />
                    )}
                    <span className={`platform-badge ${i.platform}`}>
                      {i.platform === "bluesky" ? "B" : "M"}
                    </span>
                    <span className="person-identity-handle">{i.handle}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <h2 className="section-title">
              Posts {posts.length > 0 && `(${posts.length})`}
            </h2>

            {posts.length === 0 && (
              <p className="text-muted">No posts fetched yet for this person.</p>
            )}

            <div className="timeline-feed">
              {posts.map((post) => (
                <PostCard key={`${post.platform}-${post.id}`} post={post} blueskyAgent={agentRef.current} />
              ))}

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
          </section>
        </>
      )}
    </AppLayout>
  );
}
