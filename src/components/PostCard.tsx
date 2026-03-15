"use client";

interface MediaItem {
  type: string;
  url: string;
  alt: string;
}

interface PostData {
  id: number;
  platform: string;
  content: string | null;
  contentHtml: string | null;
  media: MediaItem[] | null;
  repostOfId: string | null;
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
  alsoPostedOn?: string[];
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

  return (
    <article className="post-card">
      <div className="post-author">
        {author?.avatarUrl && (
          <img src={author.avatarUrl} alt="" className="post-avatar" />
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
            {author?.handle}
          </span>
        </div>
        <span className="post-timestamp">{relativeTime(post.postedAt)}</span>
      </div>

      {post.alsoPostedOn && post.alsoPostedOn.length > 0 && (
        <div className="post-crosspost">
          Also on{" "}
          {post.alsoPostedOn
            .map((p) => (p === "bluesky" ? "Bluesky" : "Mastodon"))
            .join(", ")}
        </div>
      )}

      <div className="post-content">
        {post.contentHtml ? (
          <div dangerouslySetInnerHTML={{ __html: post.contentHtml }} />
        ) : (
          <p>{post.content}</p>
        )}
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
              className="post-media-img"
              loading="lazy"
            />
          ))}
        </div>
      )}

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
    </article>
  );
}
