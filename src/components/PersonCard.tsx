"use client";

import { useState } from "react";

interface Identity {
  id: number;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface Person {
  id: number;
  displayName: string | null;
  autoMatched: boolean;
  matchConfidence: number | null;
  identities: Identity[];
}

export function PersonCard({
  person,
  onUpdate,
}: {
  person: Person;
  onUpdate: () => void;
}) {
  const [unlinking, setUnlinking] = useState<number | null>(null);

  async function handleUnlink(identityId: number) {
    setUnlinking(identityId);
    try {
      const res = await fetch("/api/graph/identities/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityId }),
      });
      if (!res.ok) throw new Error("Failed");
      onUpdate();
    } catch (err) {
      console.error(err);
    } finally {
      setUnlinking(null);
    }
  }

  return (
    <div className="person-card">
      <div className="person-header">
        <p className="person-name">{person.displayName || "Unknown"}</p>
        {person.autoMatched && (
          <span className="person-badge">
            Auto-matched
            {person.matchConfidence != null &&
              ` (${Math.round(person.matchConfidence * 100)}%)`}
          </span>
        )}
      </div>

      <div className="person-identities">
        {person.identities.map((identity) => (
          <div key={identity.id} className="person-identity-row">
            {identity.avatarUrl && (
              <img
                src={identity.avatarUrl}
                alt=""
                className="person-identity-avatar"
              />
            )}
            <span className={`platform-badge ${identity.platform}`}>
              {identity.platform === "bluesky" ? "B" : "M"}
            </span>
            <span className="person-identity-handle">{identity.handle}</span>
            <button
              onClick={() => handleUnlink(identity.id)}
              disabled={unlinking === identity.id}
              className="btn-unlink"
            >
              {unlinking === identity.id ? "..." : "Unlink"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
