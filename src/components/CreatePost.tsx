"use client";

import { useState, useRef } from "react";

export interface ReplyTarget {
  id: number;
  platform: string;
  platformPostId: string;
  platformPostCid: string | null;
  threadRootId: string | null;
  threadRootCid: string | null;
  content: string | null;
  authorHandle: string | null;
  authorDisplayName: string | null;
  authorAvatar: string | null;
  alsoPostedOn: Array<{
    platform: string;
    platformPostId: string;
    platformPostCid: string | null;
    threadRootId: string | null;
    threadRootCid: string | null;
  }>;
}

interface CreatePostProps {
  onClose?: () => void;
  onPosted?: () => void;
  replyTo?: ReplyTarget;
}

const MAX_IMAGES = 4;
const MAX_LENGTH = 300;
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

export function CreatePost({ onClose, onPosted, replyTo }: CreatePostProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [alts, setAlts] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [editingAltIndex, setEditingAltIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasContent = text.trim().length > 0 || images.length > 0;
  const canPost = hasContent && text.length <= MAX_LENGTH && !posting;

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const remaining = MAX_IMAGES - images.length;
    const toAdd = files.slice(0, remaining);

    // Reset input so same file can be re-selected after removal
    if (fileInputRef.current) fileInputRef.current.value = "";

    const compressed = await Promise.all(toAdd.map(compressImage));
    setImages((prev) => [...prev, ...compressed]);
    setPreviews((prev) => [...prev, ...compressed.map((f) => URL.createObjectURL(f))]);
    setAlts((prev) => [...prev, ...compressed.map(() => "")]);
  }

  function removeImage(index: number) {
    URL.revokeObjectURL(previews[index]);
    setImages((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    setAlts((prev) => prev.filter((_, i) => i !== index));
  }

  async function uploadToBluesky(): Promise<{ image: unknown; alt: string }[]> {
    return Promise.all(
      images.map(async (file, i) => {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/bluesky/upload-blob", { method: "POST", body: formData });
        if (!res.ok) throw new Error("Bluesky media upload failed");
        const data = await res.json();
        return { image: data.blob, alt: alts[i] || "" };
      })
    );
  }

  async function uploadToMastodon(): Promise<string[]> {
    return Promise.all(
      images.map(async (file, i) => {
        const formData = new FormData();
        formData.append("file", file);
        if (alts[i]) formData.append("description", alts[i]);
        const res = await fetch("/api/posts/upload-media", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error("Mastodon media upload failed");
        const data = await res.json();
        return data.id as string;
      })
    );
  }

  // Resolve which platform-specific posts we're replying to (if any). The
  // primary post is the one the user clicked Reply on; alsoPostedOn lists
  // mirrors on other platforms. We send a reply to every available target.
  function getReplyTargets() {
    if (!replyTo) return { bluesky: undefined, mastodon: undefined };

    let bluesky:
      | { uri: string; cid: string; threadRootId: string | null; threadRootCid: string | null }
      | undefined;
    let mastodon: { statusId: string } | undefined;

    const consider = (
      platform: string,
      platformPostId: string,
      platformPostCid: string | null,
      threadRootId: string | null,
      threadRootCid: string | null,
    ) => {
      if (platform === "bluesky" && platformPostCid && !bluesky) {
        bluesky = { uri: platformPostId, cid: platformPostCid, threadRootId, threadRootCid };
      }
      if (platform === "mastodon" && !mastodon) {
        mastodon = { statusId: platformPostId };
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

    return { bluesky, mastodon };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true);
    setError(null);

    const content = text.trim();
    const results: string[] = [];
    const errors: string[] = [];
    const isReply = !!replyTo;
    const { bluesky: bsReplyTarget, mastodon: mastoReplyTarget } = getReplyTargets();

    async function postToBluesky(blueskyImages?: { image: unknown; alt: string }[]): Promise<boolean> {
      const body: Record<string, unknown> = { text: content };
      if (blueskyImages && blueskyImages.length > 0) body.images = blueskyImages;
      if (bsReplyTarget) {
        body.replyTo = { uri: bsReplyTarget.uri, cid: bsReplyTarget.cid };
        body.replyRoot =
          bsReplyTarget.threadRootId && bsReplyTarget.threadRootCid
            ? { uri: bsReplyTarget.threadRootId, cid: bsReplyTarget.threadRootCid }
            : { uri: bsReplyTarget.uri, cid: bsReplyTarget.cid };
      }
      const res = await fetch("/api/bluesky/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    }

    async function postToMastodon(mediaIds?: string[]): Promise<boolean> {
      const body: Record<string, unknown> = { content };
      if (mediaIds && mediaIds.length > 0) body.mediaIds = mediaIds;
      if (mastoReplyTarget) body.inReplyToId = mastoReplyTarget.statusId;
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    }

    // Determine which platforms to send to. For replies, only platforms
    // where we have a corresponding target. For new posts, both.
    const sendToBluesky = isReply ? !!bsReplyTarget : true;
    const sendToMastodon = isReply ? !!mastoReplyTarget : true;

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

    setPosting(false);

    if (results.length > 0) {
      setText("");
      previews.forEach((url) => URL.revokeObjectURL(url));
      setImages([]);
      setPreviews([]);
      setSuccess(true);
      onPosted?.();
    } else {
      setError(`Failed to post to ${errors.join(" and ")}.`);
    }
  }

  if (success) {
    return (
      <div className="create-post-success">
        <span>Posted!</span>
        <button className="create-post-success-close" onClick={() => { setSuccess(false); onClose?.(); }}>
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

  return (
    <form onSubmit={handleSubmit} className="create-post-form">
      {replyTo && (
        <div className="create-post-reply-target">
          {replyTo.authorAvatar && (
            <img src={replyTo.authorAvatar} alt="" className="create-post-reply-avatar" />
          )}
          <div className="create-post-reply-body">
            <div className="create-post-reply-author">
              {replyTo.authorDisplayName || replyTo.authorHandle}
            </div>
            {replyTo.content && (
              <div className="create-post-reply-text">{replyTo.content}</div>
            )}
          </div>
        </div>
      )}
      <textarea
        className="post-reply-input create-post-input"
        placeholder={replyTo ? "Write your reply…" : "What's up?"}
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        rows={4}
        maxLength={MAX_LENGTH}
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
          <span className="post-reply-charcount" style={{ color: text.length > MAX_LENGTH * 0.9 ? "var(--color-error)" : undefined }}>
            {text.length}/{MAX_LENGTH}
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {onClose && (
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={posting}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!canPost}>
            {posting ? "Posting..." : "Post"}
          </button>
        </div>
      </div>
    </form>
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
          {generating ? "Generating…" : "Generate with AI"}
        </button>
        <span className="alt-editor-charcount">
          {draft.length}/{ALT_MAX}
        </span>
      </div>
    </div>
  );
}
