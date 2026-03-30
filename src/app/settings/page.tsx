"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppHeader";
import { clearBlueskySession, setBlueskyAgent } from "@/lib/bluesky-oauth";

interface Account {
  id: number;
  platform: string;
  handle: string;
  lastSyncAt: string | null;
}

export default function SettingsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/accounts")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setAccounts(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
        // Clear cached timeline
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
        router.push("/");
      }
    } catch (err) {
      console.error("Reset error:", err);
    } finally {
      setDisconnecting(null);
    }
  }

  const mastodon = accounts.find((a) => a.platform === "mastodon");
  const bluesky = accounts.find((a) => a.platform === "bluesky");

  return (
    <AppLayout>
      <section className="section">
        <h2 className="section-title">Settings</h2>

        {loading && (
          <div className="spinner-container">
            <div className="spinner" />
          </div>
        )}

        {!loading && (
          <>
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
                  <button
                    onClick={handleDisconnectMastodon}
                    disabled={disconnecting !== null}
                    className="btn btn-danger-outline"
                  >
                    {disconnecting === "mastodon" ? "Disconnecting..." : "Disconnect Mastodon"}
                  </button>
                  <p className="settings-account-note">
                    Removes your Mastodon connection, posts, and follows. You can reconnect with the same or a different account afterwards.
                  </p>
                </div>
              ) : (
                <div className="settings-account">
                  <p className="settings-account-note">
                    No Mastodon account connected. Go to <a href="/">Accounts</a> to connect one.
                  </p>
                </div>
              )}
            </div>

            <div className="settings-group settings-mobile-only">
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
                className="btn btn-danger"
              >
                {disconnecting === "all" ? "Resetting..." : "Reset Everything"}
              </button>
            </div>
          </>
        )}
      </section>
    </AppLayout>
  );
}
