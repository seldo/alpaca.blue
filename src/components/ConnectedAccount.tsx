"use client";

import { useState, useRef, useEffect } from "react";
import {
  getBlueskyOAuthClient,
  getBlueskyAgent,
  setBlueskyAgent,
  clearBlueskySession,
} from "@/lib/bluesky-oauth";

interface Account {
  id: number;
  platform: string;
  handle: string;
  lastSyncAt: string | null;
  createdAt: string;
}

export function ConnectedAccount({
  account,
  onSync,
}: {
  account: Account;
  onSync: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);

  useEffect(() => {
    if (account.platform !== "bluesky") return;

    // Check for a cached agent first (set during OAuth in BlueskyConnect)
    const existing = getBlueskyAgent();
    if (existing) {
      agentRef.current = existing;
      return;
    }

    // No cached agent — try to restore session from browser storage
    (async () => {
      try {
        const client = await getBlueskyOAuthClient();
        const result = await client.init();
        if (result?.session) {
          const { Agent } = await import("@atproto/api");
          const agent = new Agent(result.session);
          agentRef.current = agent;
          setBlueskyAgent(agent);
        } else {
          setSessionExpired(true);
        }
      } catch {
        setSessionExpired(true);
      }
    })();
  }, [account.platform]);

  async function handleReconnect() {
    setReconnecting(true);
    setResult(null);
    try {
      // Clear stale DPoP keys/session before starting fresh
      await clearBlueskySession();
      const client = await getBlueskyOAuthClient();
      await client.signIn(account.handle, {
        scope: "atproto transition:generic",
      });
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Reconnect failed");
      setReconnecting(false);
    }
  }

  const handleImport = async () => {
    setImporting(true);
    setResult(null);

    try {
      if (account.platform === "bluesky") {
        await importBluesky();
      } else {
        const res = await fetch("/api/graph/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: account.platform }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Import failed");
        setResult(`Imported ${data.imported} follows`);
      }
      onSync();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  async function importBluesky() {
    const agent = agentRef.current;
    if (!agent || !agent.did) {
      setSessionExpired(true);
      throw new Error("Session expired");
    }

    setResult("Fetching follows...");

    const allFollows: Array<{
      handle: string;
      did: string;
      displayName?: string;
      avatar?: string;
      description?: string;
    }> = [];

    let cursor: string | undefined;
    do {
      const response = await agent.getFollows({
        actor: agent.did,
        limit: 100,
        cursor,
      });

      for (const follow of response.data.follows) {
        allFollows.push({
          handle: follow.handle,
          did: follow.did,
          displayName: follow.displayName,
          avatar: follow.avatar,
          description: follow.description,
        });
      }
      cursor = response.data.cursor;
    } while (cursor);

    setResult(`Storing ${allFollows.length} follows...`);

    const batchSize = 100;
    let totalImported = 0;
    for (let i = 0; i < allFollows.length; i += batchSize) {
      const batch = allFollows.slice(i, i + batchSize);
      const res = await fetch("/api/graph/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "bluesky", follows: batch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      totalImported += data.imported;
    }

    setResult(`Imported ${totalImported} follows`);
  }

  const platformLabel =
    account.platform === "bluesky" ? "Bluesky" : "Mastodon";

  return (
    <div className="account-row">
      <div className="account-info">
        <div className={`platform-icon ${account.platform}`}>
          {platformLabel[0]}
        </div>
        <div>
          <p className="handle">{account.handle}</p>
          <p className="meta">
            {platformLabel}
            {account.lastSyncAt &&
              ` · Last synced ${new Date(account.lastSyncAt).toLocaleDateString()}`}
          </p>
        </div>
      </div>

      <div className="account-actions">
        {result && <span className="result-text">{result}</span>}
        {sessionExpired && account.platform === "bluesky" ? (
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="btn btn-bluesky"
          >
            {reconnecting ? "Reconnecting..." : "Reconnect"}
          </button>
        ) : (
          <button
            onClick={handleImport}
            disabled={importing}
            className="btn btn-outline"
          >
            {importing ? "Importing..." : "Import follows"}
          </button>
        )}
      </div>
    </div>
  );
}
