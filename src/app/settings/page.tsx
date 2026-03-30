"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppHeader";
import { MastodonConnect } from "@/components/MastodonConnect";
import { ConnectedAccount } from "@/components/ConnectedAccount";
import { clearBlueskySession, setBlueskyAgent } from "@/lib/bluesky-oauth";

interface Account {
  id: number;
  platform: string;
  handle: string;
  lastSyncAt: string | null;
  createdAt: string;
}

export default function SettingsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const router = useRouter();

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      if (Array.isArray(data)) setAccounts(data);
    } catch (err) {
      console.error("Failed to fetch accounts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  async function handleDisconnectMastodon() {
    if (!confirm("Disconnect your Mastodon account? This will remove all Mastodon posts, follows, and identity matches. You can reconnect afterwards.")) return;
    setDisconnecting("mastodon");
    try {
      const res = await fetch("/api/accounts/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "mastodon" }),
      });
      if (res.ok) {
        setAccounts((prev) => prev.filter((a) => a.platform !== "mastodon"));
        sessionStorage.removeItem("timeline_cache");
        sessionStorage.removeItem("timeline_scroll");
        sessionStorage.removeItem("mentions_cache");
        sessionStorage.removeItem("mentions_scroll");
      }
    } catch (err) {
      console.error("Disconnect error:", err);
    } finally {
      setDisconnecting(null);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setBlueskyAgent(null);
    sessionStorage.clear();
    router.push("/login");
    setTimeout(() => {
      clearBlueskySession().catch(() => {});
    }, 100);
  }

  async function handleResetAll() {
    if (!confirm("Reset everything? This will delete all your data (accounts, posts, follows, identities). You will need to reconnect and re-import everything.")) return;
    if (!confirm("Are you sure? This cannot be undone.")) return;
    setDisconnecting("all");
    try {
      const res = await fetch("/api/accounts/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "all" }),
      });
      if (res.ok) {
        sessionStorage.clear();
        router.push("/timeline");
      }
    } catch (err) {
      console.error("Reset error:", err);
    } finally {
      setDisconnecting(null);
    }
  }

  const bluesky = accounts.find((a) => a.platform === "bluesky");
  const mastodon = accounts.find((a) => a.platform === "mastodon");
  const isFullySetUp = accounts.length >= 2 && accounts.every((a) => a.lastSyncAt !== null);

  return (
    <AppLayout>
      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && !isFullySetUp && (
        <section className="section">
          <div className="welcome-card">
            <h2 className="welcome-title">Welcome to alpaca.blue</h2>
            <p className="welcome-text">
              See your Bluesky and Mastodon timelines merged into a single feed.
              Connect both accounts and import your follows to get started.
            </p>
          </div>

          <h2 className="section-title">Getting Started</h2>

          <div className="setup-step setup-step-done">
            <div className="setup-step-number">1</div>
            <div className="setup-step-content">
              <p className="setup-step-label">Bluesky connected</p>
              <p className="setup-step-detail">{bluesky?.handle}</p>
            </div>
          </div>

          {!mastodon ? (
            <div className="setup-step">
              <div className="setup-step-number">2</div>
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
                <p className="setup-step-detail">{mastodon.handle}</p>
              </div>
            </div>
          )}

          <div className="setup-step">
            <div className="setup-step-number">3</div>
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
      )}

      {!loading && (
        <section className="section">
          <h2 className="section-title">Settings</h2>

          <div className="settings-group">
            <h3 className="settings-group-title">Connected Accounts</h3>

            {bluesky && (
              <div className="settings-account">
                <div className="settings-account-info">
                  <span className="platform-badge bluesky">B</span>
                  <span className="settings-account-handle">{bluesky.handle}</span>
                  {bluesky.lastSyncAt && (
                    <span className="settings-account-status">Follows imported</span>
                  )}
                </div>
                {isFullySetUp && (
                  <ConnectedAccount account={bluesky} onSync={fetchAccounts} />
                )}
                <p className="settings-account-note">
                  Bluesky is your login account and cannot be disconnected. Log out and log in with a different account if needed.
                </p>
              </div>
            )}

            {mastodon ? (
              <div className="settings-account">
                <div className="settings-account-info">
                  <span className="platform-badge mastodon">M</span>
                  <span className="settings-account-handle">{mastodon.handle}</span>
                  {mastodon.lastSyncAt && (
                    <span className="settings-account-status">Follows imported</span>
                  )}
                </div>
                {isFullySetUp && (
                  <ConnectedAccount account={mastodon} onSync={fetchAccounts} />
                )}
                <button
                  onClick={handleDisconnectMastodon}
                  disabled={disconnecting !== null}
                  className="btn btn-danger-outline settings-action-btn"
                >
                  {disconnecting === "mastodon" ? "Disconnecting..." : "Disconnect Mastodon"}
                </button>
              </div>
            ) : (
              <div className="settings-account">
                <p className="settings-account-note">No Mastodon account connected.</p>
                <MastodonConnect />
              </div>
            )}
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title">Account</h3>
            <button onClick={handleLogout} className="btn btn-outline">
              Log out
            </button>
          </div>

          <div className="settings-group settings-danger-zone">
            <h3 className="settings-group-title">Danger Zone</h3>
            <p className="settings-account-note">
              Delete all your data and start over. This removes all accounts, posts, follows, and identity matches.
            </p>
            <button
              onClick={handleResetAll}
              disabled={disconnecting !== null}
              className="btn btn-danger settings-action-btn"
            >
              {disconnecting === "all" ? "Resetting..." : "Reset Everything"}
            </button>
          </div>
        </section>
      )}
    </AppLayout>
  );
}
