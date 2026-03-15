"use client";

import { useState, useRef, useEffect } from "react";

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
  const agentRef = useRef<import("@atproto/api").Agent | null>(null);

  // For Bluesky, restore the OAuth session so we can fetch follows client-side
  useEffect(() => {
    if (account.platform !== "bluesky") return;

    (async () => {
      try {
        const { BrowserOAuthClient } = await import(
          "@atproto/oauth-client-browser"
        );
        const origin = window.location.origin;
        const isLocalhost = window.location.hostname === "127.0.0.1";

        let clientId: string;
        if (isLocalhost) {
          const cimdRes = await fetch("https://cimd-service.fly.dev/clients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: "alpaca.blue",
              client_uri: origin,
              redirect_uris: [`${origin}/`],
              scope: "atproto transition:generic",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
              application_type: "web",
              dpop_bound_access_tokens: true,
            }),
          });
          if (!cimdRes.ok) return;
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
            redirect_uris: [`${origin}/`],
            scope: "atproto transition:generic",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            application_type: "web",
            dpop_bound_access_tokens: true,
          },
          handleResolver: "https://bsky.social",
        });

        const result = await client.init();
        if (result?.session) {
          const { Agent } = await import("@atproto/api");
          agentRef.current = new Agent(result.session);
        }
      } catch {
        // Session not available — import won't work for Bluesky
      }
    })();
  }, [account.platform]);

  const handleImport = async () => {
    setImporting(true);
    setResult(null);

    try {
      if (account.platform === "bluesky") {
        await importBluesky();
      } else {
        // Mastodon import happens server-side
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
      throw new Error(
        "Bluesky session expired. Please reconnect your account."
      );
    }

    setResult("Fetching follows...");

    // Fetch all follows client-side
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

    // Send to server in batches
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
        <button
          onClick={handleImport}
          disabled={importing}
          className="btn btn-outline"
        >
          {importing ? "Importing..." : "Import follows"}
        </button>
      </div>
    </div>
  );
}
