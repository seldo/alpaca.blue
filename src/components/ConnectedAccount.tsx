"use client";

import { useState } from "react";

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

  const handleImport = async () => {
    setImporting(true);
    setResult(null);

    try {
      const res = await fetch("/api/graph/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: account.platform }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Import failed");
      }

      setResult(`Imported ${data.imported} follows`);
      onSync();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

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
