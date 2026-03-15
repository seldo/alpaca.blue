"use client";

import { useState, useRef, useEffect } from "react";
import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";

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
      const { BrowserOAuthClient } = await import(
        "@atproto/oauth-client-browser"
      );

      // RFC 8252: use loopback IP instead of localhost
      if (window.location.hostname === "localhost") {
        window.location.hostname = "127.0.0.1";
        return;
      }

      const origin = window.location.origin;
      const redirectUri = `${origin}/`;
      const isLocalhost = window.location.hostname === "127.0.0.1";

      let clientId: string;

      if (isLocalhost) {
        // Use CIMD service for localhost dev
        const cimdRes = await fetch("https://cimd-service.fly.dev/clients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "alpaca.blue",
            client_uri: origin,
            redirect_uris: [redirectUri],
            scope: "atproto transition:generic",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            application_type: "web",
            dpop_bound_access_tokens: true,
          }),
        });
        if (!cimdRes.ok)
          throw new Error("Failed to register OAuth client with CIMD service");
        const cimdData = await cimdRes.json();
        clientId = cimdData.client_id;
      } else {
        clientId = `${origin}/api/client-metadata`;
      }

      const client = new BrowserOAuthClient({
        clientMetadata: {
          client_id: clientId,
          client_name: "alpaca.blue",
          client_uri: origin,
          redirect_uris: [redirectUri],
          scope: "atproto transition:generic",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "web",
          dpop_bound_access_tokens: true,
        },
        handleResolver: "https://bsky.social",
      });

      clientRef.current = client;

      // Check if returning from OAuth redirect
      const result = await client.init();

      if (result?.session) {
        setStatus("Saving connection...");
        setLoading(true);

        const { Agent } = await import("@atproto/api");
        const agent = new Agent(result.session);

        const profile = await agent.getProfile({
          actor: result.session.did,
        });

        // Save the connection server-side
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
