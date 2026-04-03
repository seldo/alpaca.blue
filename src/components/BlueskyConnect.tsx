"use client";

import { useState } from "react";

export function BlueskyConnect({
  onConnected,
}: {
  onConnected: () => void;
}) {
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedHandle = handle.trim().replace(/^@/, "");
    if (!trimmedHandle) return;

    setLoading(true);
    setError(null);

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
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="platform-icon bluesky">B</div>
        <div>
          <h3>Bluesky</h3>
          <p className="subtitle">Connect with OAuth</p>
        </div>
      </div>

      <form onSubmit={handleSignIn} className="form-group">
        <input
          type="text"
          placeholder="Handle (e.g. you.bsky.social)"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          className="input"
          required
        />
        <div className="form-footer-end">
          <button type="submit" disabled={loading} className="btn btn-bluesky">
            {loading ? "Redirecting..." : "Connect"}
          </button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
