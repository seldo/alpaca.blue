"use client";

// Client-native realtime, replacing the SSE worker for the client pipeline.
// Mirrors what each platform's own web client does:
//   • Mastodon → WebSocket `user` stream (push) — same as the official web app.
//   • Bluesky  → poll getTimeline on an interval — same as bsky.app (no client
//     consumes the firehose for a home timeline).
// Both feed into the same "stash fresh posts behind a pill" UX in the hook.

import type { MastodonCredentials } from "./mastodon";
import type { MastodonStatus } from "./transform";
import type { BlueskyClient } from "./bluesky";

export interface RealtimeOptions {
  mastodon: MastodonCredentials | null;
  bluesky: BlueskyClient | null;
  // Called with new home-timeline statuses pushed over the Mastodon WSS.
  onMastodonStatuses: (statuses: MastodonStatus[]) => void;
  // Called on each Bluesky poll tick (and on tab refocus); the caller fetches.
  onBlueskyTick: () => void;
  pollIntervalMs?: number;
}

// Resolves the instance's streaming WSS base. Prefers the instance-advertised
// URL (v1 `urls.streaming_api` or v2 `configuration.urls.streaming`); falls back
// to deriving wss from the instance host.
async function resolveStreamingUrl(creds: MastodonCredentials): Promise<string> {
  const fallback = creds.instanceUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/api/v1/streaming";
  try {
    const res = await fetch(`${creds.instanceUrl}/api/v1/instance`);
    if (res.ok) {
      const data = await res.json();
      const base: string | undefined = data?.urls?.streaming_api || data?.configuration?.urls?.streaming;
      if (base) {
        return base.includes("/api/v1/streaming")
          ? base
          : base.replace(/\/$/, "") + "/api/v1/streaming";
      }
    }
  } catch {
    /* fall through to derived URL */
  }
  return fallback;
}

// Starts realtime delivery. Returns a stop() that tears everything down.
export function startRealtime(opts: RealtimeOptions): () => void {
  const { mastodon, bluesky, onMastodonStatuses, onBlueskyTick } = opts;
  const pollInterval = opts.pollIntervalMs ?? 25_000;
  let stopped = false;

  // ── Mastodon WSS ────────────────────────────────────────
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 2000;

  async function connectMastodon() {
    if (stopped || !mastodon) return;
    const base = await resolveStreamingUrl(mastodon);
    if (stopped) return;
    // Browsers can't set Authorization on a WebSocket, so the token goes in the
    // query string — Mastodon's streaming API accepts `access_token` there.
    const url = `${base}?stream=user&access_token=${encodeURIComponent(mastodon.accessToken)}`;
    try {
      ws = new WebSocket(url);
    } catch {
      return scheduleReconnect();
    }
    ws.onopen = () => { backoff = 2000; };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.event === "update" && msg.payload) {
          onMastodonStatuses([JSON.parse(msg.payload) as MastodonStatus]);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
      ws = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (stopped || !mastodon) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectMastodon, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  // ── Bluesky polling ─────────────────────────────────────
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePoll() {
    if (stopped || !bluesky) return;
    pollTimer = setTimeout(() => {
      if (!document.hidden) onBlueskyTick();
      schedulePoll();
    }, pollInterval);
  }

  // Refocus: reconnect a dropped WSS and catch up Bluesky immediately.
  function onVisibility() {
    if (document.hidden) return;
    if (mastodon && !ws) connectMastodon();
    if (bluesky) onBlueskyTick();
  }
  document.addEventListener("visibilitychange", onVisibility);

  if (mastodon) connectMastodon();
  if (bluesky) schedulePoll();

  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(pollTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    ws?.close();
    ws = null;
  };
}
