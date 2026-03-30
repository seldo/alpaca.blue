"use client";

import { useState, useRef } from "react";
import type { Agent, BlobRef } from "@atproto/api";

interface CreatePostProps {
  blueskyAgent: Agent | null;
  onClose?: () => void;
  onPosted?: () => void;
}

const MAX_IMAGES = 4;
const MAX_LENGTH = 300;

export function CreatePost({ blueskyAgent, onClose, onPosted }: CreatePostProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasContent = text.trim().length > 0 || images.length > 0;
  const canPost = hasContent && text.length <= MAX_LENGTH && !posting;

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const remaining = MAX_IMAGES - images.length;
    const toAdd = files.slice(0, remaining);

    setImages((prev) => [...prev, ...toAdd]);
    setPreviews((prev) => [
      ...prev,
      ...toAdd.map((f) => URL.createObjectURL(f)),
    ]);

    // Reset input so same file can be re-selected after removal
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeImage(index: number) {
    URL.revokeObjectURL(previews[index]);
    setImages((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  async function uploadToBluesky(agent: Agent): Promise<{ image: BlobRef; alt: string }[]> {
    return Promise.all(
      images.map(async (file) => {
        const arrayBuffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        const { data } = await agent.uploadBlob(uint8, { encoding: file.type });
        return { image: data.blob, alt: "" };
      })
    );
  }

  async function uploadToMastodon(): Promise<string[]> {
    return Promise.all(
      images.map(async (file) => {
        const formData = new FormData();
        formData.append("file", file);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true);
    setError(null);

    const content = text.trim();
    const results: string[] = [];
    const errors: string[] = [];

    // Post to Bluesky
    if (blueskyAgent) {
      try {
        if (images.length > 0) {
          const blueskyImages = await uploadToBluesky(blueskyAgent);
          await blueskyAgent.post({
            text: content,
            embed: {
              $type: "app.bsky.embed.images",
              images: blueskyImages,
            },
          });
        } else {
          await blueskyAgent.post({ text: content });
        }
        results.push("Bluesky");
      } catch (err) {
        console.error("Bluesky post error:", err);
        errors.push("Bluesky");
      }
    }

    // Post to Mastodon
    try {
      let mediaIds: string[] = [];
      if (images.length > 0) {
        mediaIds = await uploadToMastodon();
      }
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mediaIds }),
      });
      if (res.ok) {
        results.push("Mastodon");
      } else {
        errors.push("Mastodon");
      }
    } catch {
      errors.push("Mastodon");
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

  return (
    <form onSubmit={handleSubmit} className="create-post-form">
      <textarea
        className="post-reply-input create-post-input"
        placeholder="What's up?"
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
