"use client";

import { useEffect, useRef } from "react";

export type RealtimeChannel = "timeline" | "mentions" | "reactions";

// Subscribes to the streaming worker's SSE channels and calls `onNudge(channel)`
// whenever the worker reports new activity for this user (a followed post, a
// mention, or a reaction). Auth is via a short-lived token from
// /api/realtime/token (the cross-origin EventSource can't use the session
// cookie). Handles reconnect + token refresh: on any error we close and
// reconnect, which mints a fresh token.
export function useRealtimeUpdates(onNudge: (channel: RealtimeChannel) => void): void {
  const onNudgeRef = useRef(onNudge);
  useEffect(() => {
    onNudgeRef.current = onNudge;
  }, [onNudge]);

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 2000;

    async function connect() {
      if (stopped) return;
      try {
        const res = await fetch("/api/realtime/token");
        if (!res.ok) return schedule();
        const { token, workerUrl } = await res.json();
        if (!token || !workerUrl || stopped) return schedule();

        es = new EventSource(`${workerUrl}/events?token=${encodeURIComponent(token)}`);
        const channels: RealtimeChannel[] = ["timeline", "mentions", "reactions"];
        for (const ch of channels) {
          es.addEventListener(ch, () => onNudgeRef.current(ch));
        }
        es.onopen = () => {
          backoff = 2000;
        };
        es.onerror = () => {
          // EventSource would auto-retry with the same (possibly expired) token;
          // close and reconnect so we fetch a fresh one.
          es?.close();
          es = null;
          schedule();
        };
      } catch {
        schedule();
      }
    }

    function schedule() {
      if (stopped) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    }

    connect();

    // Proactively refresh well before the 1h token TTL so a long-open tab
    // doesn't drop.
    const refresh = setInterval(
      () => {
        es?.close();
        es = null;
        connect();
      },
      50 * 60 * 1000,
    );

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(refresh);
      es?.close();
    };
  }, []);
}
