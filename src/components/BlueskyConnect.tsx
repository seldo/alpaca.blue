"use client";

import { useState, useRef, useEffect } from "react";
import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { getBlueskyOAuthClient, setBlueskyAgent } from "@/lib/bluesky-oauth";

export function BlueskyConnect({
  onConnected,
}: {
  onConnected: () => void;
}) {
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<BrowserOAuthClient | null>(null);

  useEffect(() => {
    initOAuth();
  }, []);

  async function initOAuth() {
    try {
      const client = await getBlueskyOAuthClient();
      clientRef.current = client;

      // Check if returning from OAuth redirect
      const result = await client.init();

      if (result?.session) {
        setStatus("Saving connection...");
        setLoading(true);

        const { Agent } = await import("@atproto/api");
        const agent = new Agent(result.session);
        setBlueskyAgent(agent);

        const profile = await agent.getProfile({
          actor: result.session.did,
        });

        await fetch("/api/auth/bluesky", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: profile.data.handle,
            did: result.session.did,
          }),
        });

        setLoading(false);
        setStatus("");
        onConnected();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth init failed");
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    const trimmedHandle = handle.trim().replace(/^@/, "");
    if (!trimmedHandle || !clientRef.current) return;

    setLoading(true);
    setError(null);
    setStatus("Redirecting to Bluesky...");

    try {
      await clientRef.current.signIn(trimmedHandle, {
        scope: "atproto transition:generic",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setLoading(false);
      setStatus("");
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
          <button
            type="submit"
            disabled={loading || !clientRef.current}
            className="btn btn-bluesky"
          >
            {loading ? status || "Connecting..." : "Connect"}
          </button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
