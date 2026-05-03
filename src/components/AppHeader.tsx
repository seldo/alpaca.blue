"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { CreatePost } from "@/components/CreatePost";

interface UserInfo {
  id: number;
  blueskyHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
  needsReauth?: boolean;
}

// Module-scope cache so the sidebar avatar/handle survive client-side
// navigations between pages without flickering. AppLayout is rendered by
// each page individually, so it remounts on every nav — without this
// cache we'd refetch /api/auth/me from scratch and show an empty sidebar
// for a frame.
let cachedUser: UserInfo | null = null;

function getScreenTitle(pathname: string): string {
  if (pathname === "/profile") return "Profile";
  if (pathname === "/timeline") return "Timeline";
  if (pathname.startsWith("/posts/")) return "Post";
  if (pathname === "/mentions") return "Mentions";
  if (pathname === "/identities") return "Identities";
  if (pathname.startsWith("/identities/")) return "Identity";
  if (pathname.startsWith("/persons/")) return "Person";
  if (pathname === "/settings") return "Settings";
  if (pathname === "/") return "Home";
  return "alpaca.blue";
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(cachedUser);
  const [composeOpen, setComposeOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const screenTitle = getScreenTitle(pathname);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        cachedUser = data;
        setUser(data);
      })
      .catch(() => {});
  }, []);

  // Close drawer on route change.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    sessionStorage.clear();
    cachedUser = null;
    router.push("/login");
  }

  return (
    <div className="app-layout">
      {user?.needsReauth && (
        <div className="reauth-banner">
          Bluesky needs to be reconnected.{" "}
          <button className="reauth-banner-btn" onClick={handleLogout}>Log out and back in</button>
          {" "}to fix this.
        </div>
      )}
      <div className="app-layout-body">
      <aside className="app-sidebar">
        <div className="app-sidebar-top">
          <Link href="/" className="app-sidebar-logo">
            <img src="/logomark.svg" alt="" className="app-sidebar-logo-icon" />
            <img src="/logo-horizontal.svg" alt="alpaca.blue" className="app-sidebar-logo-full" />
          </Link>

          {user?.avatarUrl && (
            <Link
              href="/profile"
              className={`app-sidebar-profile${pathname === "/profile" ? " app-sidebar-profile-active" : ""}`}
              title="Profile"
            >
              <img src={user.avatarUrl} alt="" className="app-sidebar-avatar" />
              <div className="app-sidebar-userinfo">
                <span className="app-sidebar-displayname">{user.displayName || user.blueskyHandle}</span>
                <span className="app-sidebar-handle">@{user.blueskyHandle}</span>
              </div>
            </Link>
          )}

          <button className="btn btn-primary app-sidebar-compose" onClick={() => setComposeOpen(true)}>
            New Post
          </button>

          <nav className="app-sidebar-nav">
            <Link
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
            </Link>
            <Link
              href="/mentions"
              className={`app-sidebar-item${pathname === "/mentions" ? " app-sidebar-active" : ""}`}
              title="Mentions"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
              </svg>
              <span className="app-sidebar-label">Mentions</span>
            </Link>
            <Link
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
            </Link>
          </nav>
        </div>

        <div className="app-sidebar-bottom">
          <Link
            href="/settings"
            className={`app-sidebar-item${pathname === "/settings" ? " app-sidebar-active" : ""}`}
            title="Settings"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="app-sidebar-label">Settings</span>
          </Link>
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
      <header className="app-topbar">
        <button
          className="app-topbar-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <h1 className="app-topbar-title">{screenTitle}</h1>
        <Link href="/settings" className="app-topbar-btn" aria-label="Settings">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </header>

      {drawerOpen && (
        <div className="app-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <nav className="app-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="app-drawer-header">
              <Link href="/" className="app-drawer-logo">
                <img src="/logo-horizontal.svg" alt="alpaca.blue" />
              </Link>
              <button
                className="app-drawer-close"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {user?.avatarUrl && (
              <div className="app-drawer-profile">
                <img src={user.avatarUrl} alt="" className="app-drawer-avatar" />
                <div className="app-drawer-userinfo">
                  <span className="app-drawer-displayname">{user.displayName || user.blueskyHandle}</span>
                  <span className="app-drawer-handle">@{user.blueskyHandle}</span>
                </div>
              </div>
            )}
            <div className="app-drawer-items">
              <Link href="/profile" className={`app-drawer-item${pathname === "/profile" ? " app-drawer-active" : ""}`}>Profile</Link>
              <Link href="/timeline" className={`app-drawer-item${pathname === "/timeline" || pathname.startsWith("/posts/") ? " app-drawer-active" : ""}`}>Timeline</Link>
              <Link href="/mentions" className={`app-drawer-item${pathname === "/mentions" ? " app-drawer-active" : ""}`}>Mentions</Link>
              <Link href="/identities" className={`app-drawer-item${pathname === "/identities" || pathname.startsWith("/persons/") || pathname.startsWith("/identities/") ? " app-drawer-active" : ""}`}>Identities</Link>
              <Link href="/settings" className={`app-drawer-item${pathname === "/settings" ? " app-drawer-active" : ""}`}>Settings</Link>
              <button onClick={handleLogout} className="app-drawer-item app-drawer-logout">Log out</button>
            </div>
          </nav>
        </div>
      )}

      <div className="app-content">
        {children}
      </div>

      {composeOpen && (
        <div className="create-post-modal-backdrop" onClick={() => setComposeOpen(false)}>
          <div className="create-post-modal" onClick={(e) => e.stopPropagation()}>
            <p className="create-post-modal-title">New Post</p>
            <CreatePost
              onClose={() => setComposeOpen(false)}
              onPosted={() => setComposeOpen(false)}
            />
          </div>
        </div>
      )}

      <nav className="app-bottombar">
        <Link href="/timeline" prefetch className={`app-bottombar-item${pathname === "/timeline" || pathname.startsWith("/posts/") ? " app-bottombar-active" : ""}`} aria-label="Timeline">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="17" y1="10" x2="3" y2="10" />
            <line x1="21" y1="6" x2="3" y2="6" />
            <line x1="21" y1="14" x2="3" y2="14" />
            <line x1="17" y1="18" x2="3" y2="18" />
          </svg>
        </Link>
        <Link href="/mentions" prefetch className={`app-bottombar-item${pathname === "/mentions" ? " app-bottombar-active" : ""}`} aria-label="Mentions">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
          </svg>
        </Link>
        <Link href="/profile" prefetch className={`app-bottombar-item${pathname === "/profile" ? " app-bottombar-active" : ""}`} aria-label="Profile">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
        </Link>
        <button
          type="button"
          className="app-bottombar-compose"
          onClick={() => setComposeOpen(true)}
          aria-label="New post"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </nav>
      </div>
    </div>
  );
}
