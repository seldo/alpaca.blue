// SSE push endpoint for the streaming worker.
//
// The browser can't authenticate to the worker with the app's iron-session
// cookie (different origin), so the flow is: the Next app (which has the
// session) mints a short-lived random token into the shared Redis, the browser
// opens an EventSource to this worker with ?token=…, and we validate the token
// against Redis to learn the userId. When the sync modules store new posts for a
// user, we nudge that user's open connections; the client then fetches the
// timeline and shows a "N new posts" pill. We send only a nudge (no content),
// so this channel carries nothing sensitive.

import { createServer, type ServerResponse } from "http";
import { redis, keys } from "@/lib/redis";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
// Token is the auth, not cookies, so a permissive CORS origin is fine; override
// with APP_URL if you want to lock it down.
const ALLOW_ORIGIN = process.env.APP_URL || "*";
const HEARTBEAT_MS = 25000; // keep proxies/Fly from idling the connection
const NUDGE_FLUSH_MS = 2000; // coalesce bursts of stores into one client nudge

export type Channel = "timeline" | "mentions" | "reactions";

// userId -> set of open SSE responses
const clients = new Map<number, Set<ServerResponse>>();
// userId -> set of channels with a pending nudge, flushed on an interval
let pendingNudges = new Map<number, Set<Channel>>();

function corsHeaders(): Record<string, string> {
  return { "Access-Control-Allow-Origin": ALLOW_ORIGIN };
}

// Called by the sync modules when something new landed for a user, tagged by
// which feed changed. Coalesced so a burst produces at most one nudge per
// channel per flush window.
export function notifyUser(userId: number, channel: Channel = "timeline"): void {
  let set = pendingNudges.get(userId);
  if (!set) {
    set = new Set();
    pendingNudges.set(userId, set);
  }
  set.add(channel);
}

async function flushNudges(): Promise<void> {
  if (pendingNudges.size === 0) return;
  const batch = pendingNudges;
  pendingNudges = new Map();

  for (const [userId, channels] of batch) {
    // Reactions are served from a Redis cache the app polls; bust it before
    // nudging so the client's re-fetch returns fresh data (the worker doesn't
    // rebuild the cache itself).
    if (channels.has("reactions")) {
      await redis.del(keys.blueskyReactions(userId)).catch(() => {});
      await redis.del(keys.mastodonReactions(userId)).catch(() => {});
    }
    const set = clients.get(userId);
    if (!set || set.size === 0) continue;
    for (const channel of channels) {
      const payload = `event: ${channel}\ndata: {}\n\n`;
      for (const res of set) {
        try {
          res.write(payload);
        } catch {
          // dead connection; the 'close' handler will clean it up
        }
      }
    }
  }
}

export function startSseServer(): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (url.pathname !== "/events") {
      res.writeHead(404);
      res.end();
      return;
    }

    const token = url.searchParams.get("token");
    const userId = token
      ? await redis.get<number>(keys.realtimeToken(token)).catch(() => null)
      : null;
    if (!userId) {
      res.writeHead(401, corsHeaders());
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    });
    res.write("retry: 5000\n\n");
    res.write("event: ready\ndata: {}\n\n");

    let set = clients.get(userId);
    if (!set) {
      set = new Set();
      clients.set(userId, set);
    }
    set.add(res);

    const hb = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(hb);
      const s = clients.get(userId);
      if (s) {
        s.delete(res);
        if (s.size === 0) clients.delete(userId);
      }
    });
  });

  setInterval(() => {
    flushNudges().catch((err) => console.error("[sse] flush error:", err));
  }, NUDGE_FLUSH_MS);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[sse] listening on :${PORT}`);
  });
}
