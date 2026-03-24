"use client";

import { useState, useEffect, useCallback } from "react";
import { MastodonConnect } from "@/components/MastodonConnect";
import { ConnectedAccount } from "@/components/ConnectedAccount";
import { AppLayout } from "@/components/AppHeader";

interface Account {
  id: number;
  platform: string;
  handle: string;
  lastSyncAt: string | null;
  createdAt: string;
}

export default function Home() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      if (Array.isArray(data)) {
        setAccounts(data);
      }
    } catch (err) {
      console.error("Failed to fetch accounts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const mastodonConnected = accounts.some((a) => a.platform === "mastodon");

  return (
    <AppLayout>

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && (
        <>
          {accounts.length > 0 && (
            <section className="section">
              <h2 className="section-title">Connected Accounts</h2>
              {accounts.map((account) => (
                <ConnectedAccount
                  key={account.id}
                  account={account}
                  onSync={fetchAccounts}
                />
              ))}
            </section>
          )}

          {!mastodonConnected && (
            <section className="section">
              <h2 className="section-title">Add Mastodon Account</h2>
              <MastodonConnect />
            </section>
          )}

          <section className="section">
            <h2 className="section-title">Your Timeline</h2>
            <div className="card">
              <p style={{ fontSize: "0.875rem", marginBottom: "12px" }}>
                See posts from both platforms in a single, merged feed.
              </p>
              <a href="/timeline" className="btn btn-bluesky" style={{ textDecoration: "none", display: "inline-block" }}>
                View Timeline
              </a>
            </div>
          </section>

          {mastodonConnected && (
            <section className="section">
              <h2 className="section-title">Identity Resolution</h2>
              <div className="card">
                <p style={{ fontSize: "0.875rem", marginBottom: "12px" }}>
                  Match people across Bluesky and Mastodon to see a unified view
                  of their posts.
                </p>
                <a href="/identities" className="btn btn-outline" style={{ textDecoration: "none", display: "inline-block" }}>
                  Manage Identities
                </a>
              </div>
            </section>
          )}
        </>
      )}
    </AppLayout>
  );
}
