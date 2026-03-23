"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { PostCard } from "@/components/PostCard";

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
  alsoPostedOn: string[];
}

export default function PersonPage() {
  const params = useParams();
  const personId = params.id as string;

  const [personName, setPersonName] = useState<string>("");
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

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
    <main className="main">
      <div className="header">
        <img
          src="/logo-horizontal.svg"
          alt="alpaca.blue"
          className="header-logo"
        />
        <p>{personName || "Person"}</p>
      </div>

      <nav className="page-nav">
        <a href="/timeline" className="link">
          Timeline
        </a>
        <span className="nav-sep">/</span>
        <span className="nav-current">{personName}</span>
      </nav>

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
                <PostCard key={`${post.platform}-${post.id}`} post={post} />
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
    </main>
  );
}
