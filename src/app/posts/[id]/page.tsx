"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { UserNav } from "@/components/UserNav";

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
  person: {
    id: number;
    displayName: string | null;
  } | null;
  alsoPostedOn: Array<{ platform: string; postUrl: string | null }>;
}

export default function PostPage() {
  const params = useParams();
  const [post, setPost] = useState<PostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPost() {
      try {
        const res = await fetch(`/api/posts/${params.id}`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to load post");
        }
        setPost(await res.json());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load post");
      } finally {
        setLoading(false);
      }
    }
    fetchPost();
  }, [params.id]);

  return (
    <main className="main">
      <UserNav />
      <div className="header">
        <img
          src="/logo-horizontal.svg"
          alt="alpaca.blue"
          className="header-logo"
        />
      </div>

      <nav className="page-nav">
        <a href="/" className="link">
          Accounts
        </a>
        <span className="nav-sep">/</span>
        <a href="/timeline" className="link">
          Timeline
        </a>
        <span className="nav-sep">/</span>
        <span className="nav-current">Post</span>
      </nav>

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {error && (
        <p className="error" style={{ textAlign: "center", padding: "40px 0" }}>
          {error}
        </p>
      )}

      {post && (
        <div className="timeline-feed">
          <PostCard post={post} />
        </div>
      )}
    </main>
  );
}
