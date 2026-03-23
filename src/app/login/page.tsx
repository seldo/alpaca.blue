"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { getBlueskyOAuthClient, setBlueskyAgent } from "@/lib/bluesky-oauth";

export default function LoginPage() {
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<BrowserOAuthClient | null>(null);
  const router = useRouter();

  useEffect(() => {
    initOAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initOAuth() {
    try {
      const client = await getBlueskyOAuthClient();
      clientRef.current = client;

      // Check if returning from OAuth redirect
      const result = await client.init();

      if (result?.session) {
        setStatus("Logging in...");
        setLoading(true);

        const { Agent } = await import("@atproto/api");
        const agent = new Agent(result.session);
        setBlueskyAgent(agent);

        const profile = await agent.getProfile({
          actor: result.session.did,
        });

        // This creates/finds the user and sets the session cookie
        const res = await fetch("/api/auth/bluesky", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: profile.data.handle,
            did: result.session.did,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Login failed");
        }

        router.push("/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth init failed");
      setLoading(false);
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
    <main className="main auth-page">
      <div className="auth-container">
        <img src="/logo-horizontal.svg" alt="alpaca.blue" className="header-logo" />
        <p className="auth-subtitle">Log in with your Bluesky account</p>

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
            disabled={loading || !clientRef.current}
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
