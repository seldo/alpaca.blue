"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

function ImageModal({
  images,
  index,
  onClose,
  onNavigate,
}: {
  images: Array<{ url: string; alt: string }>;
  index: number;
  onClose: () => void;
  onNavigate: (newIndex: number) => void;
}) {
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;
  const showArrows = images.length > 1;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) onNavigate(index - 1);
      if (e.key === "ArrowRight" && hasNext) onNavigate(index + 1);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, onNavigate, index, hasPrev, hasNext]);

  const current = images[index];

  return (
    <div className="image-modal-overlay" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <button className="image-modal-close" onClick={onClose}>
        &times;
      </button>
      {showArrows && hasPrev && (
        <button
          className="image-modal-arrow image-modal-prev"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
        >
          &#8249;
        </button>
      )}
      <img
        src={current.url}
        alt={current.alt}
        className="image-modal-img"
        onClick={(e) => e.stopPropagation()}
      />
      {showArrows && hasNext && (
        <button
          className="image-modal-arrow image-modal-next"
          onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
        >
          &#8250;
        </button>
      )}
      {showArrows && (
        <div className="image-modal-counter">
          {index + 1} / {images.length}
        </div>
      )}
    </div>
  );
}

interface MediaItem {
  type: string;
  url: string;
  alt: string;
}

interface PostData {
  id: number;
  platform: string;
  platformPostId: string;
  postUrl: string | null;
  content: string | null;
  contentHtml: string | null;
  media: MediaItem[] | null;
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
  alsoPostedOn?: Array<{ platform: string; postUrl: string | null }>;
}

function getPostUrl(post: PostData): string | null {
  // Use canonical URL from the platform when available
  if (post.postUrl) return post.postUrl;

  if (post.platform === "bluesky" && post.author) {
    // AT URI: at://did:plc:xxx/app.bsky.feed.post/rkey
    const rkey = post.platformPostId.split("/").pop();
    if (rkey) {
      return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
    }
  }
  return null;
}

function getProfileUrl(author: PostData["author"]): string | null {
  if (!author) return null;
  if (author.profileUrl) return author.profileUrl;
  if (author.platform === "bluesky") {
    return `https://bsky.app/profile/${author.handle}`;
  }
  if (author.platform === "mastodon") {
    const match = author.handle.match(/^@([^@]+)@(.+)$/);
    if (match) return `https://${match[2]}/@${match[1]}`;
  }
  return null;
}

function getQuotedPostUrl(quotedPost: NonNullable<PostData["quotedPost"]>): string | null {
  if (!quotedPost.uri) return null;
  // AT URI: at://did:plc:xxx/app.bsky.feed.post/rkey
  const parts = quotedPost.uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (parts) {
    return `https://bsky.app/profile/${quotedPost.authorHandle}/post/${parts[2]}`;
  }
  return null;
}


function linkifyText(text: string): string {
  // Escape HTML, then linkify URLs
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(dateStr).toLocaleDateString();
}

function formatCount(n: number | null): string {
  if (!n) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function PostCard({ post }: { post: PostData }) {
  const author = post.author;
  const mediaItems: MediaItem[] = Array.isArray(post.media)
    ? post.media
    : [];

  const personLink = post.person
    ? `/persons/${post.person.id}`
    : null;

  const postUrl = getPostUrl(post);
  const profileUrl = getProfileUrl(author);
  const router = useRouter();
  const [modalState, setModalState] = useState<{
    images: Array<{ url: string; alt: string }>;
    index: number;
  } | null>(null);

  const openImageModal = useCallback(
    (images: Array<{ url: string; alt: string }>, index: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setModalState({ images, index });
    },
    []
  );

  function handleCardClick(e: React.MouseEvent) {
    // Don't navigate if clicking a link, button, image, or anything in the media area
    const target = e.target as HTMLElement;
    if (
      target.closest("a") ||
      target.closest("button") ||
      target.tagName === "IMG" ||
      target.closest(".post-media")
    ) return;
    router.push(`/posts/${post.id}`);
  }

  return (
    <article className="post-card post-card-clickable" onClick={handleCardClick}>
      <div className="post-author">
        {author?.avatarUrl && (
          profileUrl ? (
            <a href={profileUrl} target="_blank" rel="noopener noreferrer">
              <img src={author.avatarUrl} alt="" className="post-avatar" />
            </a>
          ) : (
            <img src={author.avatarUrl} alt="" className="post-avatar" />
          )
        )}
        <div className="post-author-info">
          <span className="post-author-name">
            {personLink ? (
              <a href={personLink} className="post-person-link">
                {post.person?.displayName || author?.displayName || author?.handle}
              </a>
            ) : (
              author?.displayName || author?.handle
            )}
          </span>
          <span className="post-author-handle">
            <span className={`platform-badge ${post.platform}`}>
              {post.platform === "bluesky" ? "B" : "M"}
            </span>
            {profileUrl ? (
              <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="post-handle-link">
                {author?.handle}
              </a>
            ) : (
              author?.handle
            )}
          </span>
        </div>
        {postUrl ? (
          <a href={postUrl} target="_blank" rel="noopener noreferrer" className="post-timestamp">
            {relativeTime(post.postedAt)}
          </a>
        ) : (
          <span className="post-timestamp">{relativeTime(post.postedAt)}</span>
        )}
      </div>

      {post.alsoPostedOn && post.alsoPostedOn.length > 0 && (
        <div className="post-crosspost">
          Also on{" "}
          {post.alsoPostedOn.map((p, i) => {
            const name = p.platform === "bluesky" ? "Bluesky" : "Mastodon";
            return (
              <span key={p.platform}>
                {i > 0 && ", "}
                {p.postUrl ? (
                  <a href={p.postUrl} target="_blank" rel="noopener noreferrer" className="post-crosspost-link">
                    {name}
                  </a>
                ) : (
                  name
                )}
              </span>
            );
          })}
        </div>
      )}

      <div className="post-content">
        {post.contentHtml ? (
          <div dangerouslySetInnerHTML={{ __html: post.contentHtml }} />
        ) : post.content ? (
          <div dangerouslySetInnerHTML={{ __html: linkifyText(post.content) }} />
        ) : null}
      </div>

      {mediaItems.length > 0 && (
        <div
          className={`post-media ${mediaItems.length === 1 ? "single" : "grid"}`}
        >
          {mediaItems.map((m, i) => (
            <img
              key={i}
              src={m.url}
              alt={m.alt || ""}
              className="post-media-img post-media-img-clickable"
              loading="lazy"
              onClick={(e) => openImageModal(
                mediaItems.map((mi) => ({ url: mi.url, alt: mi.alt || "" })),
                i,
                e
              )}
            />
          ))}
        </div>
      )}

      {post.quotedPost && post.quotedPost.authorHandle && (() => {
        const qp = post.quotedPost;
        const qpUrl = getQuotedPostUrl(qp);

        async function handleQuotedPostClick(e: React.MouseEvent) {
          e.stopPropagation();
          const target = e.target as HTMLElement;
          if (target.closest("a") || target.closest("button") || target.tagName === "IMG") return;

          if (!qp.uri) return;

          try {
            const res = await fetch("/api/posts/lookup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                uri: qp.uri,
                authorHandle: qp.authorHandle,
                authorDisplayName: qp.authorDisplayName,
                authorAvatar: qp.authorAvatar,
                text: qp.text,
                media: qp.media,
                postedAt: qp.postedAt,
              }),
            });
            const data = await res.json();
            if (data.id) {
              router.push(`/posts/${data.id}`);
            }
          } catch {
            // If lookup fails, open on platform as fallback
            if (qpUrl) window.open(qpUrl, "_blank");
          }
        }

        return (
          <div className="quoted-post quoted-post-clickable" onClick={handleQuotedPostClick}>
            <div className="quoted-post-author">
              {qp.authorAvatar && (
                <img src={qp.authorAvatar} alt="" className="quoted-post-avatar" />
              )}
              <span className="quoted-post-name">
                {qp.authorDisplayName || qp.authorHandle}
              </span>
              <span className="quoted-post-handle">@{qp.authorHandle}</span>
            </div>
            {qp.text && (
              <div className="quoted-post-content">
                <div dangerouslySetInnerHTML={{ __html: linkifyText(qp.text) }} />
              </div>
            )}
            {qp.media && qp.media.length > 0 && (
              <div className={`post-media ${qp.media.length === 1 ? "single" : "grid"}`}>
                {qp.media.map((m, i) => (
                  <img
                    key={i}
                    src={m.url}
                    alt={m.alt || ""}
                    className="post-media-img post-media-img-clickable"
                    loading="lazy"
                    onClick={(e) => openImageModal(
                      qp.media!.map((mi) => ({ url: mi.url, alt: mi.alt || "" })),
                      i,
                      e
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })()}

      <div className="post-engagement">
        {post.replyCount ? (
          <span className="post-stat">{formatCount(post.replyCount)} replies</span>
        ) : null}
        {post.repostCount ? (
          <span className="post-stat">{formatCount(post.repostCount)} reposts</span>
        ) : null}
        {post.likeCount ? (
          <span className="post-stat">{formatCount(post.likeCount)} likes</span>
        ) : null}
      </div>

      {modalState && (
        <ImageModal
          images={modalState.images}
          index={modalState.index}
          onClose={() => setModalState(null)}
          onNavigate={(newIndex) => setModalState({ ...modalState, index: newIndex })}
        />
      )}
    </article>
  );
}
