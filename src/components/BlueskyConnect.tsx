"use client";

import { useState } from "react";

export function BlueskyConnect({
  onConnected,
}: {
  onConnected: () => void;
}) {
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/bluesky", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, appPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Authentication failed");
      }

      setHandle("");
      setAppPassword("");
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="platform-icon bluesky">B</div>
        <div>
          <h3>Bluesky</h3>
          <p className="subtitle">Connect with an app password</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="form-group">
        <input
          type="text"
          placeholder="Handle (e.g. you.bsky.social)"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          className="input"
          required
        />
        <input
          type="password"
          placeholder="App password"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
          className="input"
          required
        />
        <div className="form-footer">
          <a
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noopener noreferrer"
            className="link"
          >
            Create an app password
          </a>
          <button type="submit" disabled={loading} className="btn btn-bluesky">
            {loading ? "Connecting..." : "Connect"}
          </button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
