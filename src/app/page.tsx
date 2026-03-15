"use client";

import { useState, useEffect, useCallback } from "react";
import { BlueskyConnect } from "@/components/BlueskyConnect";
import { MastodonConnect } from "@/components/MastodonConnect";
import { ConnectedAccount } from "@/components/ConnectedAccount";

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
      setAccounts(data);
    } catch (err) {
      console.error("Failed to fetch accounts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const blueskyConnected = accounts.some((a) => a.platform === "bluesky");
  const mastodonConnected = accounts.some((a) => a.platform === "mastodon");

  return (
    <main className="main">
      <div className="header">
        <img src="/logo-horizontal.svg" alt="alpaca.blue" className="header-logo" />
        <p>Your unified social timeline</p>
      </div>

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

          <section className="section">
            <h2 className="section-title">
              {accounts.length > 0
                ? "Add Another Account"
                : "Connect Your Accounts"}
            </h2>
            {!blueskyConnected && (
              <BlueskyConnect onConnected={fetchAccounts} />
            )}
            {!mastodonConnected && <MastodonConnect />}
            {blueskyConnected && mastodonConnected && (
              <p className="text-muted">
                Both platforms connected. More platforms coming soon.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
