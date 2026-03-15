"use client";

import { useState, useEffect, useCallback } from "react";
import { SuggestionCard } from "@/components/SuggestionCard";
import { PersonCard } from "@/components/PersonCard";

interface Identity {
  id: number;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
}

interface Person {
  id: number;
  displayName: string | null;
  autoMatched: boolean;
  matchConfidence: number | null;
  identities: Identity[];
}

interface Suggestion {
  id: number;
  heuristicScore: number;
  llmConfidence: number | null;
  llmReasoning: string | null;
  bluesky?: Identity;
  mastodon?: Identity;
}

export default function IdentitiesPage() {
  const [persons, setPersons] = useState<Person[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [unlinked, setUnlinked] = useState<Identity[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [identRes, suggestRes] = await Promise.all([
        fetch("/api/graph/identities"),
        fetch("/api/graph/identities/suggestions"),
      ]);
      const identData = await identRes.json();
      const suggestData = await suggestRes.json();

      if (identData.persons) setPersons(identData.persons);
      if (identData.unlinked) setUnlinked(identData.unlinked);
      if (Array.isArray(suggestData)) setSuggestions(suggestData);
    } catch (err) {
      console.error("Failed to fetch identity data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleResolve() {
    setResolving(true);
    setResolveResult(null);
    try {
      const res = await fetch("/api/graph/identities/resolve", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Resolution failed");
      setResolveResult(
        `Found ${data.candidatesFound} candidates, evaluated ${data.llmEvaluated}, ` +
          `auto-confirmed ${data.autoConfirmed}, ${data.suggestionsCreated} pending`
      );
      fetchData();
    } catch (err) {
      setResolveResult(
        err instanceof Error ? err.message : "Resolution failed"
      );
    } finally {
      setResolving(false);
    }
  }

  return (
    <main className="main">
      <div className="header">
        <img
          src="/logo-horizontal.svg"
          alt="alpaca.blue"
          className="header-logo"
        />
        <p>Identity Resolution</p>
      </div>

      <nav className="page-nav">
        <a href="/" className="link">
          Back to accounts
        </a>
      </nav>

      {loading && (
        <div className="spinner-container">
          <div className="spinner" />
        </div>
      )}

      {!loading && (
        <>
          <section className="section">
            <div className="resolve-header">
              <h2 className="section-title">Match Pipeline</h2>
              <button
                onClick={handleResolve}
                disabled={resolving}
                className="btn btn-bluesky"
              >
                {resolving ? "Running..." : "Run Resolution"}
              </button>
            </div>
            {resolveResult && (
              <p className="resolve-result">{resolveResult}</p>
            )}
          </section>

          {suggestions.length > 0 && (
            <section className="section">
              <h2 className="section-title">
                Pending Suggestions ({suggestions.length})
              </h2>
              {suggestions.map((s) => (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  onAction={fetchData}
                />
              ))}
            </section>
          )}

          {persons.length > 0 && (
            <section className="section">
              <h2 className="section-title">
                Matched Persons ({persons.length})
              </h2>
              {persons.map((p) => (
                <PersonCard key={p.id} person={p} onUpdate={fetchData} />
              ))}
            </section>
          )}

          {unlinked.length > 0 && (
            <section className="section">
              <h2 className="section-title">
                Unlinked Identities ({unlinked.length})
              </h2>
              <div className="unlinked-list">
                {unlinked.map((i) => (
                  <div key={i.id} className="unlinked-row">
                    <span className={`platform-badge ${i.platform}`}>
                      {i.platform === "bluesky" ? "B" : "M"}
                    </span>
                    <span className="unlinked-handle">{i.handle}</span>
                    <span className="unlinked-name">
                      {i.displayName || ""}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
