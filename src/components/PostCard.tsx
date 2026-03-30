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
  platformPostCid?: string | null;
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
  replyToAuthor?: { handle: string; dbPostId: number; postUrl: string | null } | null;
  replyToMe?: boolean;
}

interface BlueskyAgentLike {
  like: (uri: string, cid: string) => Promise<{ uri: string }>;
  deleteLike: (uri: string) => Promise<void>;
  repost: (uri: string, cid: string) => Promise<{ uri: string }>;
  post: (record: {
    text: string;
    reply?: {
      root: { uri: string; cid: string };
      parent: { uri: string; cid: string };
    };
    embed?: {
      $type: string;
      record: { uri: string; cid: string };
    };
  }) => Promise<{ uri: string; cid: string }>;
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

export function PostCard({ post, blueskyAgent }: { post: PostData; blueskyAgent?: BlueskyAgentLike | null }) {
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
  const [favorited, setFavorited] = useState(false);
  const [localLikeCount, setLocalLikeCount] = useState(post.likeCount || 0);
  const [favoriting, setFavoriting] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const [replySuccess, setReplySuccess] = useState(false);
  const [localReplyCount, setLocalReplyCount] = useState(post.replyCount || 0);
  const [reposted, setReposted] = useState(false);
  const [localRepostCount, setLocalRepostCount] = useState(post.repostCount || 0);
  const [reposting, setReposting] = useState(false);
  const [repostMenuOpen, setRepostMenuOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteText, setQuoteText] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quoteSuccess, setQuoteSuccess] = useState(false);

  const openImageModal = useCallback(
    (images: Array<{ url: string; alt: string }>, index: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setModalState({ images, index });
    },
    []
  );

  async function handleFavorite(e: React.MouseEvent) {
    e.stopPropagation();
    if (favoriting) return;
    setFavoriting(true);

    try {
      if (post.platform === "bluesky") {
        if (!blueskyAgent || !post.platformPostCid) {
          console.warn("Cannot favorite: missing agent or CID");
          return;
        }
        if (favorited) {
          // We don't have the like URI stored, so we can't unfavorite Bluesky posts yet
          return;
        }
        await blueskyAgent.like(post.platformPostId, post.platformPostCid);
        setFavorited(true);
        setLocalLikeCount((c) => c + 1);
      } else if (post.platform === "mastodon") {
        const res = await fetch(`/api/posts/${post.id}/favorite`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unfavorite: favorited }),
        });
        if (res.ok) {
          const data = await res.json();
          setFavorited(data.favorited);
          setLocalLikeCount(data.likeCount);
        }
      }
    } catch (err) {
      console.error("Favorite error:", err);
    } finally {
      setFavoriting(false);
    }
  }

  function handleReplyToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (replySuccess) {
      setReplySuccess(false);
      setReplyText("");
    }
    setReplyOpen(!replyOpen);
  }

  async function handleReplySubmit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (replying || !replyText.trim()) return;
    setReplying(true);

    try {
      if (post.platform === "bluesky") {
        if (!blueskyAgent || !post.platformPostCid) {
          console.warn("Cannot reply: missing agent or CID");
          return;
        }
        const ref = { uri: post.platformPostId, cid: post.platformPostCid };
        await blueskyAgent.post({
          text: replyText.trim(),
          reply: { root: ref, parent: ref },
        });
        setReplySuccess(true);
        setReplyText("");
        setLocalReplyCount((c) => c + 1);
      } else if (post.platform === "mastodon") {
        const res = await fetch(`/api/posts/${post.id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: replyText.trim() }),
        });
        if (res.ok) {
          setReplySuccess(true);
          setReplyText("");
          setLocalReplyCount((c) => c + 1);
        } else {
          const data = await res.json();
          console.error("Reply failed:", data.error);
        }
      }
    } catch (err) {
      console.error("Reply error:", err);
    } finally {
      setReplying(false);
    }
  }

  function handleRepostMenuToggle(e: React.MouseEvent) {
    e.stopPropagation();
    setRepostMenuOpen(!repostMenuOpen);
  }

  async function handleRepost(e: React.MouseEvent) {
    e.stopPropagation();
    setRepostMenuOpen(false);
    if (reposting) return;
    setReposting(true);

    try {
      if (post.platform === "bluesky") {
        if (!blueskyAgent || !post.platformPostCid) {
          console.warn("Cannot repost: missing agent or CID");
          return;
        }
        if (reposted) return; // Can't undo Bluesky reposts without stored URI
        await blueskyAgent.repost(post.platformPostId, post.platformPostCid);
        setReposted(true);
        setLocalRepostCount((c) => c + 1);
      } else if (post.platform === "mastodon") {
        const res = await fetch(`/api/posts/${post.id}/repost`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ undo: reposted }),
        });
        if (res.ok) {
          const data = await res.json();
          setReposted(data.reblogged);
          setLocalRepostCount(data.repostCount);
        }
      }
    } catch (err) {
      console.error("Repost error:", err);
    } finally {
      setReposting(false);
    }
  }

  function handleQuoteOpen(e: React.MouseEvent) {
    e.stopPropagation();
    setRepostMenuOpen(false);
    if (quoteSuccess) {
      setQuoteSuccess(false);
      setQuoteText("");
    }
    setQuoteOpen(!quoteOpen);
  }

  async function handleQuoteSubmit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (quoting || !quoteText.trim()) return;
    setQuoting(true);

    try {
      if (post.platform === "bluesky") {
        if (!blueskyAgent || !post.platformPostCid) {
          console.warn("Cannot quote: missing agent or CID");
          return;
        }
        await blueskyAgent.post({
          text: quoteText.trim(),
          embed: {
            $type: "app.bsky.embed.record",
            record: { uri: post.platformPostId, cid: post.platformPostCid },
          },
        });
        setQuoteSuccess(true);
        setQuoteText("");
      } else if (post.platform === "mastodon") {
        // Mastodon doesn't support native quote posts — post as a standalone status with the URL
        const postLink = post.postUrl || "";
        const fullText = `${quoteText.trim()}\n\n${postLink}`.trim();
        const res = await fetch(`/api/posts/${post.id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: fullText, quote: true }),
        });
        if (res.ok) {
          setQuoteSuccess(true);
          setQuoteText("");
        }
      }
    } catch (err) {
      console.error("Quote error:", err);
    } finally {
      setQuoting(false);
    }
  }

  // Close repost menu when clicking outside
  useEffect(() => {
    if (!repostMenuOpen) return;
    function handleClick() { setRepostMenuOpen(false); }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [repostMenuOpen]);

  function handleCardClick(e: React.MouseEvent) {
    // Don't navigate if clicking a link, button, image, or anything in the media area
    const target = e.target as HTMLElement;
    if (
      target.closest("a") ||
      target.closest("button") ||
      target.tagName === "IMG" ||
      target.closest(".post-media") ||
      target.closest(".post-reply-composer") ||
      target.closest(".post-quote-composer") ||
      target.closest(".post-repost-menu") ||
      target.closest("textarea") ||
      target.closest("form")
    ) return;
    if (post.id > 0) {
      router.push(`/posts/${post.id}`);
    } else if (post.postUrl) {
      window.open(post.postUrl, "_blank", "noopener,noreferrer");
    }
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

      {post.replyToMe && (
        <div className="post-reply-to">Replied to you</div>
      )}

      {post.replyToAuthor && (
        <div className="post-reply-to">
          In reply to{" "}
          {post.replyToAuthor.dbPostId > 0 ? (
            <a href={`/posts/${post.replyToAuthor.dbPostId}`} className="post-reply-to-link">
              @{post.replyToAuthor.handle}
            </a>
          ) : post.replyToAuthor.postUrl ? (
            <a href={post.replyToAuthor.postUrl} target="_blank" rel="noopener noreferrer" className="post-reply-to-link">
              @{post.replyToAuthor.handle}
            </a>
          ) : (
            <span>@{post.replyToAuthor.handle}</span>
          )}
        </div>
      )}

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
        <button
          className={`post-reply-btn${replyOpen ? " post-reply-active" : ""}`}
          onClick={handleReplyToggle}
          title="Reply"
        >
          <svg className="post-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {localReplyCount > 0 && <span>{formatCount(localReplyCount)}</span>}
        </button>
        <div className="post-repost-wrapper">
          <button
            className={`post-repost-btn${reposted ? " post-reposted" : ""}`}
            onClick={handleRepostMenuToggle}
            disabled={reposting}
            title="Repost"
          >
            <svg className="post-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {localRepostCount > 0 && <span>{formatCount(localRepostCount)}</span>}
          </button>
          {repostMenuOpen && (
            <div className="post-repost-menu" onClick={(e) => e.stopPropagation()}>
              <button className="post-repost-menu-item" onClick={handleRepost}>
                {reposted ? "Undo repost" : "Repost"}
              </button>
              <button className="post-repost-menu-item" onClick={handleQuoteOpen}>
                Quote post
              </button>
            </div>
          )}
        </div>
        <button
          className={`post-favorite-btn${favorited ? " post-favorited" : ""}`}
          onClick={handleFavorite}
          disabled={favoriting}
          title={favorited ? "Unfavorite" : "Favorite"}
        >
          <svg className="post-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill={favorited ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          {localLikeCount > 0 && <span>{formatCount(localLikeCount)}</span>}
        </button>
      </div>

      {replyOpen && (
        <div className="post-reply-composer" onClick={(e) => e.stopPropagation()}>
          {replySuccess ? (
            <div className="post-reply-success">
              Reply sent!
              <button
                className="post-reply-success-close"
                onClick={(e) => { e.stopPropagation(); setReplyOpen(false); setReplySuccess(false); }}
              >
                Dismiss
              </button>
            </div>
          ) : (
            <form onSubmit={handleReplySubmit} className="post-reply-form">
              <textarea
                className="post-reply-input"
                placeholder={`Reply on ${post.platform === "bluesky" ? "Bluesky" : "Mastodon"}...`}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={3}
                maxLength={post.platform === "bluesky" ? 300 : 500}
                disabled={replying}
                autoFocus
              />
              <div className="post-reply-actions">
                <span className="post-reply-charcount">
                  {replyText.length}/{post.platform === "bluesky" ? 300 : 500}
                </span>
                <button
                  type="submit"
                  className="btn btn-primary post-reply-submit"
                  disabled={replying || !replyText.trim()}
                >
                  {replying ? "Sending..." : "Reply"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {quoteOpen && (
        <div className="post-quote-composer" onClick={(e) => e.stopPropagation()}>
          {quoteSuccess ? (
            <div className="post-reply-success">
              Quote posted!
              <button
                className="post-reply-success-close"
                onClick={(e) => { e.stopPropagation(); setQuoteOpen(false); setQuoteSuccess(false); }}
              >
                Dismiss
              </button>
            </div>
          ) : (
            <form onSubmit={handleQuoteSubmit} className="post-reply-form">
              <div className="post-quote-preview">
                <span className="post-quote-preview-author">
                  {post.author?.displayName || post.author?.handle}
                </span>
                <span className="post-quote-preview-text">
                  {(post.content || "").slice(0, 100)}{(post.content || "").length > 100 ? "..." : ""}
                </span>
              </div>
              <textarea
                className="post-reply-input"
                placeholder={`Add your comment${post.platform === "mastodon" ? " (link will be appended)" : ""}...`}
                value={quoteText}
                onChange={(e) => setQuoteText(e.target.value)}
                rows={3}
                maxLength={post.platform === "bluesky" ? 300 : 500}
                disabled={quoting}
                autoFocus
              />
              <div className="post-reply-actions">
                <span className="post-reply-charcount">
                  {quoteText.length}/{post.platform === "bluesky" ? 300 : 500}
                </span>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={(e) => { e.stopPropagation(); setQuoteOpen(false); }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary post-reply-submit"
                    disabled={quoting || !quoteText.trim()}
                  >
                    {quoting ? "Posting..." : "Quote"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}

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
