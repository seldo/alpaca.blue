"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";

interface UserInfo {
  id: number;
  blueskyHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUser(data))
      .catch(() => {});
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
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

          <nav className="app-sidebar-nav">
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
    </div>
  );
}
