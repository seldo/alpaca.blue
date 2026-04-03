"use client";

import { useState, useRef } from "react";

interface CreatePostProps {
  onClose?: () => void;
  onPosted?: () => void;
}

const MAX_IMAGES = 4;
const MAX_LENGTH = 300;
const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.85;

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

      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error("Canvas toBlob failed")); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
        },
        "image/jpeg",
        JPEG_QUALITY
      );
    };

    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Image load failed")); };
    img.src = objectUrl;
  });
}

export function CreatePost({ onClose, onPosted }: CreatePostProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
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
    setPreviews((prev) => [
      ...prev,
      ...compressed.map((f) => URL.createObjectURL(f)),
    ]);
  }

  function removeImage(index: number) {
    URL.revokeObjectURL(previews[index]);
    setImages((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  async function uploadToBluesky(): Promise<{ image: unknown; alt: string }[]> {
    return Promise.all(
      images.map(async (file) => {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/bluesky/upload-blob", { method: "POST", body: formData });
        if (!res.ok) throw new Error("Bluesky media upload failed");
        const data = await res.json();
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

    // When images are present, Mastodon goes first — Bluesky only posts if Mastodon succeeds
    if (images.length > 0) {
      let mastodonOk = false;
      try {
        const mediaIds = await uploadToMastodon();
        const res = await fetch("/api/posts/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, mediaIds }),
        });
        if (res.ok) {
          results.push("Mastodon");
          mastodonOk = true;
        } else {
          errors.push("Mastodon");
        }
      } catch (err) {
        console.error("Mastodon post error:", err);
        errors.push("Mastodon");
      }

      if (mastodonOk) {
        try {
          const blueskyImages = await uploadToBluesky();
          const bsRes = await fetch("/api/bluesky/post", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: content, images: blueskyImages }),
          });
          if (bsRes.ok) results.push("Bluesky");
          else errors.push("Bluesky");
        } catch (err) {
          console.error("Bluesky post error:", err);
          errors.push("Bluesky");
        }
      }
    } else {
      // No images — post to both independently
      const [bsRes, mastoRes] = await Promise.allSettled([
        fetch("/api/bluesky/post", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: content }),
        }),
        fetch("/api/posts/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }),
      ]);
      if (bsRes.status === "fulfilled" && bsRes.value.ok) results.push("Bluesky");
      else errors.push("Bluesky");
      if (mastoRes.status === "fulfilled" && mastoRes.value.ok) results.push("Mastodon");
      else errors.push("Mastodon");
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
