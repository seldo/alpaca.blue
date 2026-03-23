"use client";

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
  alsoPostedOn?: string[];
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

  return (
    <article className="post-card">
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
          {post.alsoPostedOn
            .map((p) => (p === "bluesky" ? "Bluesky" : "Mastodon"))
            .join(", ")}
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
            <a key={i} href={m.url} target="_blank" rel="noopener noreferrer">
              <img
                src={m.url}
                alt={m.alt || ""}
                className="post-media-img"
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}

      {post.quotedPost && post.quotedPost.authorHandle && (() => {
        const qp = post.quotedPost;
        const qpUrl = getQuotedPostUrl(qp);
        const qpProfileUrl = `https://bsky.app/profile/${qp.authorHandle}`;
        return (
          <div className="quoted-post">
            <div className="quoted-post-author">
              {qp.authorAvatar && (
                <a href={qpProfileUrl} target="_blank" rel="noopener noreferrer">
                  <img src={qp.authorAvatar} alt="" className="quoted-post-avatar" />
                </a>
              )}
              <span className="quoted-post-name">
                {qpUrl ? (
                  <a href={qpUrl} target="_blank" rel="noopener noreferrer" className="quoted-post-name-link">
                    {qp.authorDisplayName || qp.authorHandle}
                  </a>
                ) : (
                  qp.authorDisplayName || qp.authorHandle
                )}
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
                  <a key={i} href={m.url} target="_blank" rel="noopener noreferrer">
                    <img src={m.url} alt={m.alt || ""} className="post-media-img" loading="lazy" />
                  </a>
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
    </article>
  );
}
