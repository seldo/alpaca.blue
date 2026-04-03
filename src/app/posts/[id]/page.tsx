"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { AppLayout } from "@/components/AppHeader";

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
  alsoPostedOn: Array<{ platform: string; postUrl: string | null; platformPostId: string; platformPostCid: string | null; threadRootId: string | null; threadRootCid: string | null }>;
  linkCard?: { url: string; title: string; description?: string; thumb?: string } | null;
}

export default function PostPage() {
  const params = useParams();
  const router = useRouter();
  const [post, setPost] = useState<PostData | null>(null);
  const [ancestors, setAncestors] = useState<PostData[]>([]);
  const [replies, setReplies] = useState<PostData[]>([]);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
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

      // Fetch thread context in the background
      setThreadLoading(true);
      try {
        const threadRes = await fetch(`/api/posts/${params.id}/thread`);
        if (threadRes.ok) {
          const { ancestors: ancs, replies: reps } = await threadRes.json();
          setAncestors(ancs || []);
          setReplies(reps || []);
        }
      } catch {
        // Thread context is non-critical; fail silently
      } finally {
        setThreadLoading(false);
      }
    }
    init();
  }, [params.id]);

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

      {error && (
        <p className="error" style={{ textAlign: "center", padding: "40px 0" }}>
          {error}
        </p>
      )}

      {post && (
        <div className="thread-view">
          {ancestors.map((ancestor) => (
            <div key={`${ancestor.platform}-${ancestor.platformPostId}`} className="thread-ancestor-node">
              <PostCard post={ancestor} />
            </div>
          ))}

          <div className="thread-focal-node">
            <PostCard post={post} />
          </div>

          {(threadLoading && replies.length === 0) && (
            <div className="thread-loading">
              <div className="spinner spinner-sm" />
            </div>
          )}

          {replies.length > 0 && (
            <>
              <div className="thread-replies-label">Replies</div>
              {replies.map((reply) => (
                <PostCard
                  key={`${reply.platform}-${reply.platformPostId}`}
                  post={reply}
                                 />
              ))}
            </>
          )}

          {!threadLoading && replies.length === 0 && ancestors.length === 0 && (
            <p className="thread-empty">No replies yet.</p>
          )}
        </div>
      )}
    </AppLayout>
  );
}
