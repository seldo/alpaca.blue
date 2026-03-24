"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      if (Array.isArray(data)) {
        setAccounts(data);

        // If all connected accounts have imported follows, go straight to the timeline
        const allImported =
          data.length >= 2 &&
          data.every((a: Account) => a.lastSyncAt !== null);
        if (allImported) {
          router.replace("/timeline");
          return;
        }
      }
    } catch (err) {
      console.error("Failed to fetch accounts:", err);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const blueskyAccount = accounts.find((a) => a.platform === "bluesky");
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
          <section className="section">
            <div className="welcome-card">
              <h2 className="welcome-title">Welcome to alpaca.blue</h2>
              <p className="welcome-text">
                See your Bluesky and Mastodon timelines merged into a single feed.
                Connect both accounts and import your follows to get started.
              </p>
              <p className="welcome-text">
                Once you're set up, you can optionally match people who post on both
                networks so you only see each post once.
              </p>
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">Getting Started</h2>

            {blueskyAccount && (
              <div className="setup-step setup-step-done">
                <div className="setup-step-number">1</div>
                <div className="setup-step-content">
                  <p className="setup-step-label">Bluesky connected</p>
                  <p className="setup-step-detail">{blueskyAccount.handle}</p>
                </div>
              </div>
            )}

            {!mastodonConnected ? (
              <div className="setup-step">
                <div className="setup-step-number">{blueskyAccount ? "2" : "1"}</div>
                <div className="setup-step-content">
                  <p className="setup-step-label">Connect your Mastodon account</p>
                  <MastodonConnect />
                </div>
              </div>
            ) : (
              <div className="setup-step setup-step-done">
                <div className="setup-step-number">2</div>
                <div className="setup-step-content">
                  <p className="setup-step-label">Mastodon connected</p>
                  <p className="setup-step-detail">
                    {accounts.find((a) => a.platform === "mastodon")?.handle}
                  </p>
                </div>
              </div>
            )}

            <div className="setup-step">
              <div className="setup-step-number">{mastodonConnected ? "3" : blueskyAccount ? "3" : "2"}</div>
              <div className="setup-step-content">
                <p className="setup-step-label">Import your follows</p>
                <p className="setup-step-detail">
                  This lets alpaca.blue know who to show in your timeline.
                </p>
                {accounts.length > 0 && (
                  <div style={{ marginTop: "12px" }}>
                    {accounts.map((account) => (
                      <ConnectedAccount
                        key={account.id}
                        account={account}
                        onSync={fetchAccounts}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </AppLayout>
  );
}
