"use client";

import { useState } from "react";

export function MastodonConnect() {
  const [instanceUrl, setInstanceUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/mastodon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceUrl }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to start OAuth");
      }

      window.location.href = data.authUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="platform-icon mastodon">M</div>
        <div>
          <h3>Mastodon</h3>
          <p className="subtitle">Connect via OAuth</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="form-group">
        <input
          type="text"
          placeholder="Instance or handle (e.g. mastodon.social or @you@mastodon.social)"
          value={instanceUrl}
          onChange={(e) => setInstanceUrl(e.target.value)}
          className="input focus-mastodon"
          required
        />
        <div className="form-footer-end">
          <button
            type="submit"
            disabled={loading}
            className="btn btn-mastodon"
          >
            {loading ? "Connecting..." : "Connect"}
          </button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
