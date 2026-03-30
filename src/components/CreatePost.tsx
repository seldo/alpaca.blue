"use client";

import { useState } from "react";
import type { Agent } from "@atproto/api";

interface CreatePostProps {
  blueskyAgent: Agent | null;
  onClose?: () => void;
  onPosted?: () => void;
}

export function CreatePost({ blueskyAgent, onClose, onPosted }: CreatePostProps) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const maxLength = 300; // Bluesky limit; Mastodon is 500 but post to both
  const canPost = text.trim().length > 0 && text.length <= maxLength && !posting;

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
        await blueskyAgent.post({ text: content });
        results.push("Bluesky");
      } catch (err) {
        console.error("Bluesky post error:", err);
        errors.push("Bluesky");
      }
    }

    // Post to Mastodon
    try {
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
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
        maxLength={maxLength}
        disabled={posting}
        autoFocus
      />
      {error && <p className="create-post-error">{error}</p>}
      <div className="post-reply-actions">
        <span className="post-reply-charcount" style={{ color: text.length > maxLength * 0.9 ? "var(--color-error)" : undefined }}>
          {text.length}/{maxLength}
        </span>
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
