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

// userId -> set of open SSE responses
const clients = new Map<number, Set<ServerResponse>>();
// userIds with a pending nudge, flushed on an interval
const pendingNudges = new Set<number>();

function corsHeaders(): Record<string, string> {
  return { "Access-Control-Allow-Origin": ALLOW_ORIGIN };
}

// Called by the sync modules after storing new posts for a user. Coalesced so a
// burst of fan-out writes produces at most one nudge per flush window.
export function notifyUser(userId: number): void {
  pendingNudges.add(userId);
}

function flushNudges(): void {
  if (pendingNudges.size === 0) return;
  for (const userId of pendingNudges) {
    const set = clients.get(userId);
    if (!set || set.size === 0) continue;
    const payload = `event: timeline\ndata: {}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        // dead connection; the 'close' handler will clean it up
      }
    }
  }
  pendingNudges.clear();
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

  setInterval(flushNudges, NUDGE_FLUSH_MS);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[sse] listening on :${PORT}`);
  });
}
