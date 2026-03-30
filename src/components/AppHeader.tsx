"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { clearBlueskySession, setBlueskyAgent } from "@/lib/bluesky-oauth";
import { CreatePost } from "@/components/CreatePost";
import type { Agent } from "@atproto/api";

interface UserInfo {
  id: number;
  blueskyHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export function AppLayout({ children, blueskyAgent }: { children: ReactNode; blueskyAgent?: Agent | null }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUser(data))
      .catch(() => {});
  }, []);

  async function handleLogout() {
    // Clear server session
    await fetch("/api/auth/logout", { method: "POST" });
    // Clear cached agent and session storage
    setBlueskyAgent(null);
    sessionStorage.clear();
    // Navigate away first, then clear Bluesky OAuth storage
    // (clearing IndexedDB while the OAuth client is active causes "database closed" errors)
    router.push("/login");
    // Small delay to let navigation start before wiping IndexedDB
    setTimeout(() => {
      clearBlueskySession().catch(() => {});
    }, 100);
  }

  return (
    <div className="app-layout">
      <aside className="app-sidebar">
        <div className="app-sidebar-top">
          <a href="/" className="app-sidebar-logo">
            <img src="/logomark.svg" alt="" className="app-sidebar-logo-icon" />
            <img src="/logo-horizontal.svg" alt="alpaca.blue" className="app-sidebar-logo-full" />
          </a>

          {user?.avatarUrl && (
            <div className="app-sidebar-profile">
              <img src={user.avatarUrl} alt="" className="app-sidebar-avatar" />
              <div className="app-sidebar-userinfo">
                <span className="app-sidebar-displayname">{user.displayName || user.blueskyHandle}</span>
                <span className="app-sidebar-handle">@{user.blueskyHandle}</span>
              </div>
            </div>
          )}

          <button className="btn btn-primary app-sidebar-compose" onClick={() => setComposeOpen(true)}>
            New Post
          </button>

          <nav className="app-sidebar-nav">
            <a
              href="/profile"
              className={`app-sidebar-item${pathname === "/profile" ? " app-sidebar-active" : ""}`}
              title="Profile"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span className="app-sidebar-label">Profile</span>
            </a>
            <a
              href="/"
              className={`app-sidebar-item${pathname === "/" ? " app-sidebar-active" : ""}`}
              title="Accounts"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span className="app-sidebar-label">Accounts</span>
            </a>
            <a
              href="/timeline"
              className={`app-sidebar-item${pathname === "/timeline" || pathname.startsWith("/posts/") ? " app-sidebar-active" : ""}`}
              title="Timeline"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="17" y1="10" x2="3" y2="10" />
                <line x1="21" y1="6" x2="3" y2="6" />
                <line x1="21" y1="14" x2="3" y2="14" />
                <line x1="17" y1="18" x2="3" y2="18" />
              </svg>
              <span className="app-sidebar-label">Timeline</span>
            </a>
            <a
              href="/mentions"
              className={`app-sidebar-item${pathname === "/mentions" ? " app-sidebar-active" : ""}`}
              title="Mentions"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
              </svg>
              <span className="app-sidebar-label">Mentions</span>
            </a>
            <a
              href="/identities"
              className={`app-sidebar-item${pathname === "/identities" || pathname.startsWith("/persons/") ? " app-sidebar-active" : ""}`}
              title="Identities"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span className="app-sidebar-label">Identities</span>
            </a>
          </nav>
        </div>

        <div className="app-sidebar-bottom">
          <a
            href="/settings"
            className={`app-sidebar-item${pathname === "/settings" ? " app-sidebar-active" : ""}`}
            title="Settings"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="app-sidebar-label">Settings</span>
          </a>
          <button onClick={handleLogout} className="app-sidebar-item app-sidebar-logout" title="Log out">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span className="app-sidebar-label">Log out</span>
          </button>
        </div>
      </aside>
      <div className="app-content">
        {children}
      </div>
      <button className="app-fab" onClick={() => setComposeOpen(true)} title="New post">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {composeOpen && (
        <div className="create-post-modal-backdrop" onClick={() => setComposeOpen(false)}>
          <div className="create-post-modal" onClick={(e) => e.stopPropagation()}>
            <p className="create-post-modal-title">New Post</p>
            <CreatePost
              blueskyAgent={blueskyAgent ?? null}
              onClose={() => setComposeOpen(false)}
              onPosted={() => setComposeOpen(false)}
            />
          </div>
        </div>
      )}

      <nav className="app-bottombar">
        <a href="/profile" className={`app-bottombar-item${pathname === "/profile" ? " app-bottombar-active" : ""}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </a>
        <a href="/" className={`app-bottombar-item${pathname === "/" ? " app-bottombar-active" : ""}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </a>
        <a href="/timeline" className={`app-bottombar-item${pathname === "/timeline" || pathname.startsWith("/posts/") ? " app-bottombar-active" : ""}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="17" y1="10" x2="3" y2="10" />
            <line x1="21" y1="6" x2="3" y2="6" />
            <line x1="21" y1="14" x2="3" y2="14" />
            <line x1="17" y1="18" x2="3" y2="18" />
          </svg>
        </a>
        <a href="/mentions" className={`app-bottombar-item${pathname === "/mentions" ? " app-bottombar-active" : ""}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
          </svg>
        </a>
        <a href="/identities" className={`app-bottombar-item${pathname === "/identities" || pathname.startsWith("/persons/") ? " app-bottombar-active" : ""}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </a>
        <a href="/settings" className={`app-bottombar-item${pathname === "/settings" ? " app-bottombar-active" : ""}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </a>
      </nav>
    </div>
  );
}
