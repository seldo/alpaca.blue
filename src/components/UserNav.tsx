"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface UserInfo {
  id: number;
  blueskyHandle: string;
  displayName: string | null;
}

export function UserNav() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const router = useRouter();

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

  if (!user) return null;

  return (
    <div className="user-nav">
      <span className="user-nav-handle">@{user.blueskyHandle}</span>
      <button onClick={handleLogout} className="user-nav-logout">
        Log out
      </button>
    </div>
  );
}
