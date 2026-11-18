"use client";

import { useState, useRef } from "react";
import { RichText } from "@atproto/api";
import { BlueskyClient } from "@/lib/client/bluesky";
import {
  getMastodonCredentials,
  mastodonUploadMedia,
  mastodonPostStatus,
  mastodonReplyContext,
  isRestrictedVisibility,
  type MastodonCredentials,
} from "@/lib/client/mastodon";
import { expandBareDomains } from "@/lib/expand-bare-domains";

export interface ReplyTarget {
  id: number;
  platform: string;
  platformPostId: string;
  platformPostCid: string | null;
  postUrl: string | null;
  threadRootId: string | null;
  threadRootCid: string | null;
  content: string | null;
  authorHandle: string | null;
  authorDisplayName: string | null;
  authorAvatar: string | null;
  // Mastodon visibility of the post being replied to / quoted, when known.
  visibility?: string | null;
  alsoPostedOn: Array<{
    platform: string;
    postUrl: string | null;
    platformPostId: string;
    platformPostCid: string | null;
    threadRootId: string | null;
    threadRootCid: string | null;
  }>;
}

// Same data shape as ReplyTarget — re-using the type rather than coining
// a separate one. Replies and quotes both reference an existing post and
// need the same metadata to fan out cross-platform.
export type QuoteTarget = ReplyTarget;

interface CreatePostProps {
  onClose?: () => void;
  onPosted?: () => void;
  replyTo?: ReplyTarget;
  quoteOf?: QuoteTarget;
}

interface ResolvedReplyTargets {
  bluesky?: { uri: string; cid: string; threadRootId: string | null; threadRootCid: string | null };
  mastodon?: { statusId: string };
}

// For native Bluesky quote embeds we need a {uri, cid} pair. Prefer the
// primary post if it's on Bluesky; otherwise look for a Bluesky mirror.
function findBlueskyQuoteTarget(quoteOf: QuoteTarget): { uri: string; cid: string } | null {
  if (quoteOf.platform === "bluesky" && quoteOf.platformPostCid) {
    return { uri: quoteOf.platformPostId, cid: quoteOf.platformPostCid };
  }
  const mirror = quoteOf.alsoPostedOn?.find((p) => p.platform === "bluesky");
  if (mirror?.platformPostCid) {
    return { uri: mirror.platformPostId, cid: mirror.platformPostCid };
  }
  return null;
}

function computeReplyTargets(replyTo: ReplyTarget | undefined): ResolvedReplyTargets {
  if (!replyTo) return {};
  const result: ResolvedReplyTargets = {};

  const consider = (
    platform: string,
    platformPostId: string,
    platformPostCid: string | null,
    threadRootId: string | null,
    threadRootCid: string | null,
  ) => {
    if (platform === "bluesky" && platformPostCid && !result.bluesky) {
      result.bluesky = { uri: platformPostId, cid: platformPostCid, threadRootId, threadRootCid };
    }
    if (platform === "mastodon" && !result.mastodon) {
      result.mastodon = { statusId: platformPostId };
    }
  };

  consider(
    replyTo.platform,
    replyTo.platformPostId,
    replyTo.platformPostCid,
    replyTo.threadRootId,
    replyTo.threadRootCid,
  );
  for (const cp of replyTo.alsoPostedOn || []) {
    consider(cp.platform, cp.platformPostId, cp.platformPostCid, cp.threadRootId, cp.threadRootCid);
  }

  return result;
}

const MAX_IMAGES = 4;
// Bluesky's limit is 300 graphemes of the text actually sent (after bare
// domains are expanded and any quoted-post URL is appended). Mastodon's
// default is 500 characters; it only binds when Bluesky isn't a target.
const BLUESKY_MAX = 300;
const MASTODON_MAX = 500;
const MAX_DIMENSION = 2048;
const MAX_BYTES = 950_000; // Bluesky limit is 1,000,000; leave headroom

async function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width > height) {
          height = Math.round((height * MAX_DIMENSION) / width);
          width = MAX_DIMENSION;
        } else {
          width = Math.round((width * MAX_DIMENSION) / height);
          height = MAX_DIMENSION;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);

      function tryQuality(quality: number) {
        canvas.toBlob(
          (blob) => {
            if (!blob) { reject(new Error("Canvas toBlob failed")); return; }
            if (blob.size <= MAX_BYTES || quality <= 0.1) {
              resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
            } else {
              tryQuality(Math.round((quality - 0.1) * 10) / 10);
            }
          },
          "image/jpeg",
          quality
        );
      }

      tryQuality(0.85);
    };

    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Image load failed")); };
    img.src = objectUrl;
  });
}

// Prepares a picked file for upload. GIFs are left untouched so their animation
// survives — compressImage redraws onto a canvas and re-encodes as JPEG, which
// flattens an animated GIF to its first frame. Everything else is downscaled +
// JPEG-compressed to fit Bluesky's blob limit.
async function prepareForUpload(file: File): Promise<File> {
  if (file.type === "image/gif") return file;
  return compressImage(file);
}

export function CreatePost({ onClose, onPosted, replyTo, quoteOf }: CreatePostProps) {
  // Client-pipeline write clients, created lazily on first submit.
  const bskyRef = useRef<BlueskyClient | null>(null);
  const mastoRef = useRef<MastodonCredentials | null>(null);
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [alts, setAlts] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // Set when the post went out on one platform but failed on the other.
  const [partialFailure, setPartialFailure] = useState<string | null>(null);
  const [editingAltIndex, setEditingAltIndex] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasContent = text.trim().length > 0 || images.length > 0;

  // Shared by the file picker and desktop drag-and-drop. Filters to images,
  // respects the MAX_IMAGES cap, compresses, and appends.
  async function addFiles(files: File[]) {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;

    const remaining = MAX_IMAGES - images.length;
    const toAdd = imageFiles.slice(0, remaining);
    if (!toAdd.length) return;

    const prepared = await Promise.all(toAdd.map(prepareForUpload));
    setImages((prev) => [...prev, ...prepared]);
    setPreviews((prev) => [...prev, ...prepared.map((f) => URL.createObjectURL(f))]);
    setAlts((prev) => [...prev, ...prepared.map(() => "")]);
  }

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    // Reset input so the same file can be re-selected after removal
    if (fileInputRef.current) fileInputRef.current.value = "";
    await addFiles(files);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (posting) return;
    addFiles(Array.from(e.dataTransfer.files));
  }

  function removeImage(index: number) {
    URL.revokeObjectURL(previews[index]);
    setImages((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    setAlts((prev) => prev.filter((_, i) => i !== index));
  }

  async function uploadToBluesky(): Promise<{ image: unknown; alt: string }[]> {
    const bsky = bskyRef.current!;
    return Promise.all(
      images.map(async (file, i) => {
        // Bluesky's blob limit is 1MB. A GIF that fits is uploaded as-is; an
        // oversized one falls back to a static first-frame JPEG so the Bluesky
        // post still succeeds (Mastodon always gets the animated original).
        const toUpload =
          file.type === "image/gif" && file.size > MAX_BYTES ? await compressImage(file) : file;
        return { image: await bsky.uploadBlob(toUpload), alt: alts[i] || "" };
      }),
    );
  }

  async function uploadToMastodon(): Promise<string[]> {
    const creds = mastoRef.current!;
    return Promise.all(images.map((file, i) => mastodonUploadMedia(creds, file, alts[i] || "")));
  }

  // Resolve which platform-specific posts we're replying to (if any). The
  // primary post is the one the user clicked Reply on; alsoPostedOn lists
  // mirrors on other platforms. We send a reply to every available target.
  const replyTargets = computeReplyTargets(replyTo);

  // Replying to a followers-only post or a private mention on Mastodon must
  // stay on Mastodon: a Bluesky reply would publish the conversation.
  const replyIsPrivate = replyTo?.platform === "mastodon" && isRestrictedVisibility(replyTo.visibility);
  const willSendBluesky = replyTo ? !!replyTargets.bluesky && !replyIsPrivate : true;
  const bsQuoteTarget = quoteOf ? findBlueskyQuoteTarget(quoteOf) : null;

  // The exact Bluesky text for `content`: shared by the length check and the
  // actual post so they can't drift apart.
  function buildBlueskyText(content: string, hasImages: boolean): string {
    let textBody = content;
    if (quoteOf && !(bsQuoteTarget && !hasImages) && quoteOf.postUrl) {
      textBody = `${textBody}\n\n${quoteOf.postUrl}`.trim();
    }
    return textBody;
  }

  const blueskyLength = willSendBluesky
    ? new RichText({ text: expandBareDomains(buildBlueskyText(text.trim(), images.length > 0).trim()) }).graphemeLength
    : 0;
  const mastodonLength = [...text.trim()].length;
  const [usedLength, maxLength] = willSendBluesky
    ? [blueskyLength, BLUESKY_MAX]
    : [mastodonLength, MASTODON_MAX];
  const canPost = hasContent && usedLength <= maxLength && !posting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true);
    setError(null);
    try {
      await submit();
    } catch (err) {
      console.error("Post error:", err);
      setError(err instanceof Error ? err.message : "Failed to post.");
    } finally {
      setPosting(false);
    }
  }

  async function submit() {
    // Resolve the write clients once. Bluesky is always present (it's the
    // login); Mastodon only if connected.
    if (!bskyRef.current) bskyRef.current = await BlueskyClient.create();
    if (!mastoRef.current) mastoRef.current = await getMastodonCredentials();

    const content = text.trim();
    const results: string[] = [];
    const errors: string[] = [];
    const isReply = !!replyTo;
    const isQuote = !!quoteOf;
    const { bluesky: bsReplyTarget, mastodon: mastoReplyTarget } = replyTargets;

    // Mastodon reply context (the @-prefix and the visibility to post with),
    // resolved before fanning out because a restricted parent also decides
    // whether Bluesky is a target at all.
    const mastoReplyCtx =
      mastoReplyTarget && mastoRef.current
        ? await mastodonReplyContext(
            mastoRef.current,
            mastoReplyTarget.statusId,
            expandBareDomains(content),
            replyTo?.platform === "mastodon" ? replyTo.visibility : null,
          )
        : null;
    const privateReply =
      replyTo?.platform === "mastodon" &&
      (replyIsPrivate || isRestrictedVisibility(mastoReplyCtx?.visibility));

    async function postToBluesky(blueskyImages?: { image: unknown; alt: string }[]): Promise<boolean> {
      const body: Record<string, unknown> = {};
      const hasImages = !!(blueskyImages && blueskyImages.length > 0);
      const textBody = buildBlueskyText(content, hasImages);

      if (bsReplyTarget) {
        body.replyTo = { uri: bsReplyTarget.uri, cid: bsReplyTarget.cid };
        body.replyRoot =
          bsReplyTarget.threadRootId && bsReplyTarget.threadRootCid
            ? { uri: bsReplyTarget.threadRootId, cid: bsReplyTarget.threadRootCid }
            : { uri: bsReplyTarget.uri, cid: bsReplyTarget.cid };
      }

      if (isQuote) {
        // Bluesky allows a single embed per post — native quote and images
        // are mutually exclusive. Native quote when possible; otherwise
        // buildBlueskyText has appended the URL.
        if (bsQuoteTarget && !hasImages) {
          body.quote = { uri: bsQuoteTarget.uri, cid: bsQuoteTarget.cid };
        }
      }

      body.text = textBody;
      if (hasImages) body.images = blueskyImages;

      try {
        await bskyRef.current!.post(body as unknown as Parameters<BlueskyClient["post"]>[0]);
        return true;
      } catch (err) {
        console.error("Bluesky post error:", err);
        return false;
      }
    }

    async function postToMastodon(mediaIds?: string[]): Promise<boolean> {
      let textBody = content;

      if (isQuote) {
        // Mastodon has no native quote — always append the URL.
        const mastodonMirror = quoteOf!.platform === "mastodon"
          ? { postUrl: quoteOf!.postUrl }
          : quoteOf!.alsoPostedOn?.find((p) => p.platform === "mastodon");
        const url = mastodonMirror?.postUrl ?? quoteOf!.postUrl;
        if (url) textBody = `${textBody}\n\n${url}`.trim();
      }

      try {
        const creds = mastoRef.current!;
        // Bare-domain expansion + reply @-prefix (Mastodon threading rule).
        let statusText = expandBareDomains(textBody);
        if (mastoReplyCtx?.prefix) statusText = `${mastoReplyCtx.prefix} ${statusText}`.trim();
        await mastodonPostStatus(creds, {
          status: statusText,
          inReplyToId: mastoReplyTarget?.statusId,
          mediaIds,
          // Never less private than the parent (or the user's default).
          visibility: mastoReplyCtx?.visibility ?? undefined,
        });
        return true;
      } catch (err) {
        console.error("Mastodon post error:", err);
        return false;
      }
    }

    // Determine which platforms to send to:
    // - Replies: only platforms where we have a corresponding target
    //   (you can't reply where there's no thread to graft onto).
    // - Quotes and new posts: both platforms (the user is broadcasting).
    // Require the corresponding client to be available.
    const sendToBluesky = (isReply ? !!bsReplyTarget && !privateReply : true) && !!bskyRef.current;
    const sendToMastodon = (isReply ? !!mastoReplyTarget : true) && !!mastoRef.current;

    // When images are present, Mastodon goes first — Bluesky only posts if Mastodon succeeds
    if (images.length > 0) {
      let mediaIds: string[] = [];
      let mastodonOk = false;
      if (sendToMastodon) {
        try {
          mediaIds = await uploadToMastodon();
          mastodonOk = await postToMastodon(mediaIds);
          if (mastodonOk) results.push("Mastodon");
          else errors.push("Mastodon");
        } catch (err) {
          console.error("Mastodon post error:", err);
          errors.push("Mastodon");
        }
      }

      if (sendToBluesky && (!sendToMastodon || mastodonOk)) {
        try {
          const blueskyImages = await uploadToBluesky();
          const ok = await postToBluesky(blueskyImages);
          if (ok) results.push("Bluesky");
          else errors.push("Bluesky");
        } catch (err) {
          console.error("Bluesky post error:", err);
          errors.push("Bluesky");
        }
      }
    } else {
      // No images — fan out to whichever platforms apply
      const promises: Array<Promise<{ platform: string; ok: boolean }>> = [];
      if (sendToBluesky) {
        promises.push(postToBluesky().then((ok) => ({ platform: "Bluesky", ok })).catch(() => ({ platform: "Bluesky", ok: false })));
      }
      if (sendToMastodon) {
        promises.push(postToMastodon().then((ok) => ({ platform: "Mastodon", ok })).catch(() => ({ platform: "Mastodon", ok: false })));
      }
      const settled = await Promise.all(promises);
      for (const s of settled) {
        if (s.ok) results.push(s.platform);
        else errors.push(s.platform);
      }
    }

    if (results.length > 0) {
      setText("");
      previews.forEach((url) => URL.revokeObjectURL(url));
      setImages([]);
      setPreviews([]);
      setAlts([]);
      setSuccess(true);
      if (errors.length > 0) {
        // Keep the composer open so the failure is actually seen; Dismiss
        // finishes the post (closes + refreshes the feed).
        setPartialFailure(
          `Posted to ${results.join(" and ")}, but posting to ${errors.join(" and ")} failed, so it isn't there.`,
        );
      } else {
        onPosted?.();
      }
    } else {
      setError(`Failed to post to ${errors.join(" and ")}.`);
    }
  }

  if (success) {
    return (
      <div className={`create-post-success${partialFailure ? " create-post-partial" : ""}`}>
        <span>{partialFailure ?? "Posted!"}</span>
        <button
          className="create-post-success-close"
          onClick={() => {
            const wasPartial = !!partialFailure;
            setSuccess(false);
            setPartialFailure(null);
            if (wasPartial && onPosted) onPosted();
            else onClose?.();
          }}
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (editingAltIndex !== null && images[editingAltIndex]) {
    return (
      <AltEditor
        file={images[editingAltIndex]}
        previewUrl={previews[editingAltIndex]}
        value={alts[editingAltIndex] || ""}
        onSave={(newAlt) => {
          setAlts((prev) => prev.map((a, j) => (j === editingAltIndex ? newAlt : a)));
          setEditingAltIndex(null);
        }}
        onCancel={() => setEditingAltIndex(null)}
      />
    );
  }

  const reference = replyTo ?? quoteOf;

  return (
    <form
      onSubmit={handleSubmit}
      className={`create-post-form${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        // Only react to file drags, and preventDefault to allow the drop.
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          if (!posting) setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Ignore leaves into descendant elements.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="create-post-dropzone">Drop images to attach</div>
      )}
      {reference && (
        <>
          <div className="create-post-reply-target">
            {reference.authorAvatar && (
              <img src={reference.authorAvatar} alt="" className="create-post-reply-avatar" />
            )}
            <div className="create-post-reply-body">
              <div className="create-post-reply-author">
                {reference.authorDisplayName || reference.authorHandle}
              </div>
              {reference.content && (
                <div className="create-post-reply-text">{reference.content}</div>
              )}
            </div>
          </div>
          <FanoutIndicator
            verb={replyTo ? "Replying" : "Quoting"}
            platforms={
              replyTo
                ? ([
                    ...(willSendBluesky ? ["bluesky" as const] : []),
                    ...(replyTargets.mastodon ? ["mastodon" as const] : []),
                  ])
                : (["bluesky", "mastodon"] as const)
            }
          />
          {replyIsPrivate && (
            <div className="create-post-private-note">
              {replyTo?.visibility === "direct"
                ? "Private mention: your reply is only visible to the people mentioned."
                : "Followers-only post: your reply will also be followers-only."}
            </div>
          )}
        </>
      )}
      <textarea
        className="post-reply-input create-post-input"
        placeholder={replyTo ? "Write your reply…" : quoteOf ? "Add your comment…" : "What's up?"}
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        rows={4}
        disabled={posting}
        autoFocus
      />

      {previews.length > 0 && (
        <div className="create-post-images">
          {previews.map((src, i) => (
            <div key={i} className="create-post-image-preview">
              <div className="create-post-image-preview-thumb">
                <img src={src} alt="" />
                <button
                  type="button"
                  className="create-post-image-remove"
                  onClick={() => removeImage(i)}
                  disabled={posting}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
              <button
                type="button"
                className="create-post-alt-btn"
                onClick={() => setEditingAltIndex(i)}
                disabled={posting}
                title={alts[i] || "Add alt text"}
              >
                {alts[i] ? alts[i] : "+ Alt text"}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="create-post-error">{error}</p>}

      <div className="post-reply-actions">
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {images.length < MAX_IMAGES && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={handleImageSelect}
                disabled={posting}
              />
              <button
                type="button"
                className="create-post-image-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={posting}
                aria-label="Add image"
                title="Add image"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </button>
            </>
          )}
          <span className="post-reply-charcount" style={{ color: usedLength > maxLength * 0.9 ? "var(--color-error)" : undefined }}>
            {usedLength}/{maxLength}
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {onClose && (
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={posting}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!canPost}>
            {posting ? "Posting..." : replyTo ? "Reply" : quoteOf ? "Quote" : "Post"}
          </button>
        </div>
      </div>
    </form>
  );
}

function FanoutIndicator({
  verb,
  platforms,
}: {
  verb: string;
  platforms: ReadonlyArray<"bluesky" | "mastodon">;
}) {
  if (platforms.length === 0) return null;
  const meta = { bluesky: { label: "Bluesky", badge: "B" }, mastodon: { label: "Mastodon", badge: "M" } } as const;
  const labels = platforms.map((p) => meta[p].label);
  const text =
    labels.length === 1
      ? `${verb} on ${labels[0]}`
      : `${verb} on ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

  return (
    <div className="create-post-reply-targets">
      {platforms.map((p) => (
        <span key={p} className={`platform-badge ${p}`} title={meta[p].label}>
          {meta[p].badge}
        </span>
      ))}
      <span className="create-post-reply-targets-text">{text}</span>
    </div>
  );
}

const ALT_MAX = 1000;

interface AltEditorProps {
  file: File;
  previewUrl: string;
  value: string;
  onSave: (alt: string) => void;
  onCancel: () => void;
}

function AltEditor({ file, previewUrl, value, onSave, onCancel }: AltEditorProps) {
  const [draft, setDraft] = useState(value);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/ai/describe-image", { method: "POST", body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to generate alt text");
        return;
      }
      const data = await res.json();
      if (data.description) setDraft(data.description.slice(0, ALT_MAX));
    } catch (err) {
      console.error("AI describe error:", err);
      setError("Failed to generate alt text");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="alt-editor">
      <div className="alt-editor-header">
        <button type="button" className="btn btn-outline" onClick={onCancel}>
          Cancel
        </button>
        <h2 className="alt-editor-title">Alt text</h2>
        <button type="button" className="btn btn-primary" onClick={() => onSave(draft)}>
          Save
        </button>
      </div>

      <div className="alt-editor-image">
        <img src={previewUrl} alt={draft || "preview"} />
      </div>

      <textarea
        className="alt-editor-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={ALT_MAX}
        placeholder="Describe this image for screen readers…"
        autoFocus
      />

      {error && <p className="alt-editor-error">{error}</p>}

      <div className="alt-editor-actions">
        <button
          type="button"
          className="btn btn-outline alt-editor-ai-btn"
          onClick={handleGenerate}
          disabled={generating}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          </svg>
          {generating ? "Generating…" : "Describe this for me"}
        </button>
        <span className="alt-editor-charcount">
          {draft.length}/{ALT_MAX}
        </span>
      </div>
    </div>
  );
}
