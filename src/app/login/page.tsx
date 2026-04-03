"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    const err = searchParams.get("error");
    if (err) setError(decodeURIComponent(err));
  }, [searchParams]);

  async function handleSignIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedHandle = handle.trim().replace(/^@/, "");
    if (!trimmedHandle) return;

    setLoading(true);
    setError(null);
    setStatus("Redirecting to Bluesky...");

    try {
      const res = await fetch("/api/auth/bluesky/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: trimmedHandle }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Authorization failed");
      }

      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setLoading(false);
      setStatus("");
    }
  }

  return (
    <main className="main auth-page">
      <div className="auth-container">
        <img src="/logo-horizontal.svg" alt="alpaca.blue" className="header-logo" />
        <p className="auth-tagline">A combined Bluesky and Mastodon client.</p>

        <div className="auth-explainer">
          <ul className="auth-feature-list">
            <li>Unified chronological timeline from both platforms</li>
            <li>Automatically cross-post to both platforms</li>
            <li>Reply, repost, and like from either platform</li>
            <li>Mentions and replies in one place</li>
            <li>Optional cross-platform identity matching, so if other people are cross-posting you only see one post</li>
          </ul>
        </div>

        <p className="auth-subtitle">Log in with your Bluesky account to get started</p>

        <form onSubmit={handleSignIn} className="form-group">
          <input
            type="text"
            placeholder="Handle (e.g. you.bsky.social)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            className="input"
            required
          />
          <button
            type="submit"
            disabled={loading}
            className="btn btn-bluesky btn-full"
          >
            {loading ? status || "Connecting..." : "Log in with Bluesky"}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
