"use client";

import { useState } from "react";

interface Identity {
  id: number;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
}

interface Suggestion {
  id: number;
  heuristicScore: number;
  llmConfidence: number | null;
  llmReasoning: string | null;
  bluesky?: Identity;
  mastodon?: Identity;
}

export function SuggestionCard({
  suggestion,
  onAction,
}: {
  suggestion: Suggestion;
  onAction: () => void;
}) {
  const [acting, setActing] = useState(false);

  async function handleAction(action: "confirm" | "reject") {
    setActing(true);
    try {
      const res = await fetch("/api/graph/identities/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId: suggestion.id, action }),
      });
      if (!res.ok) throw new Error("Failed");
      onAction();
    } catch (err) {
      console.error(err);
    } finally {
      setActing(false);
    }
  }

  const bs = suggestion.bluesky;
  const ms = suggestion.mastodon;

  return (
    <div className="suggestion-card">
      <div className="suggestion-pair">
        <div className="suggestion-profile">
          {bs?.avatarUrl && (
            <img src={bs.avatarUrl} alt="" className="suggestion-avatar" />
          )}
          <div>
            <p className="suggestion-name">{bs?.displayName || bs?.handle}</p>
            <p className="suggestion-handle">
              <span className="platform-badge bluesky">B</span>
              {bs?.handle}
            </p>
            {bs?.bio && <p className="suggestion-bio">{bs.bio}</p>}
          </div>
        </div>

        <div className="suggestion-arrow">↔</div>

        <div className="suggestion-profile">
          {ms?.avatarUrl && (
            <img src={ms.avatarUrl} alt="" className="suggestion-avatar" />
          )}
          <div>
            <p className="suggestion-name">{ms?.displayName || ms?.handle}</p>
            <p className="suggestion-handle">
              <span className="platform-badge mastodon">M</span>
              {ms?.handle}
            </p>
            {ms?.bio && (
              <p className="suggestion-bio">
                {ms.bio.replace(/<[^>]+>/g, " ").trim()}
              </p>
            )}
          </div>
        </div>
      </div>

      {suggestion.llmReasoning && (
        <p className="suggestion-reasoning">{suggestion.llmReasoning}</p>
      )}

      <div className="suggestion-footer">
        <span className="suggestion-confidence">
          {suggestion.llmConfidence != null
            ? `${Math.round(suggestion.llmConfidence * 100)}% confidence`
            : `Heuristic: ${Math.round(suggestion.heuristicScore * 100)}%`}
        </span>
        <div className="suggestion-actions">
          <button
            onClick={() => handleAction("reject")}
            disabled={acting}
            className="btn btn-outline"
          >
            Not a match
          </button>
          <button
            onClick={() => handleAction("confirm")}
            disabled={acting}
            className="btn btn-confirm"
          >
            Same person
          </button>
        </div>
      </div>
    </div>
  );
}
