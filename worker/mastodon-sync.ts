// Real-time Mastodon timeline sync via the streaming API.
//
// Unlike Bluesky (one firehose for everyone), Mastodon has no cross-account
// firehose — each connected account gets its own authenticated `user` WebSocket
// stream, which pushes that account's home-timeline updates. We hold one socket
// per connected Mastodon account and feed `update` events straight into
// storeMastodonStatuses (the same path the poller uses), so storage/dedup/cache
// behaviour is identical.

import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { storeMastodonStatuses, type MastodonStatus } from "@/lib/posts";
import { notifyUser } from "./sse-server";

const ACCOUNT_REFRESH_MS = 2 * 60 * 1000; // re-scan connected accounts every 2 min

interface Conn {
  accountId: number;
  userId: number;
  instanceHost: string;
  ws: WebSocket | null;
  backoffMs: number;
  closed: boolean; // set when the account is removed → stop reconnecting
}

const conns = new Map<number, Conn>();

// Most instances stream from wss://{host}/api/v1/streaming, but some run a
// dedicated streaming host advertised in the instance config. Honour that when
// present, otherwise derive from the API host.
async function resolveStreamingUrl(instanceUrl: string, token: string): Promise<string> {
  const host = new URL(instanceUrl).hostname;
  let base = `wss://${host}`;
  try {
    const res = await fetch(`${instanceUrl}/api/v1/instance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      const streaming: unknown = data?.configuration?.urls?.streaming ?? data?.urls?.streaming_api;
      if (typeof streaming === "string" && streaming.startsWith("ws")) {
        base = streaming.replace(/\/$/, "");
      }
    }
  } catch {
    // fall back to the derived host
  }
  // Token goes in the query string — the WHATWG WebSocket constructor can't set
  // an Authorization header.
  return `${base}/api/v1/streaming?stream=user&access_token=${encodeURIComponent(token)}`;
}

async function connect(conn: Conn): Promise<void> {
  if (conn.closed) return;

  // Re-read the account each (re)connect so we always use current creds and
  // notice removal.
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, conn.accountId))
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) {
    console.warn(`[mastodon-sync] account ${conn.accountId} gone/credless; dropping`);
    conn.closed = true;
    conns.delete(conn.accountId);
    return;
  }

  conn.instanceHost = new URL(account.instanceUrl).hostname;
  const url = await resolveStreamingUrl(account.instanceUrl, account.accessToken);
  if (conn.closed) return;

  console.log(`[mastodon-sync] connecting account ${conn.accountId} (${conn.instanceHost})`);
  const ws = new WebSocket(url);
  conn.ws = ws;

  ws.onopen = () => {
    conn.backoffMs = 1000;
    console.log(`[mastodon-sync] account ${conn.accountId} connected`);
  };

  ws.onmessage = (event: MessageEvent) => {
    let msg: { event?: string; payload?: string };
    try {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // New posts in the home timeline (and edits). Notifications/deletes are
    // ignored here — mentions still come via the existing poll.
    if (msg.event !== "update" && msg.event !== "status.update") return;
    if (!msg.payload) return;
    let status: MastodonStatus;
    try {
      status = JSON.parse(msg.payload);
    } catch {
      return;
    }
    storeMastodonStatuses(conn.userId, [status], conn.instanceHost)
      .then((r) => {
        if (r.stored > 0) {
          notifyUser(conn.userId);
          console.log(`[mastodon-sync] stored ${r.stored} row(s) for user ${conn.userId}`);
        }
      })
      .catch((err) => console.error("[mastodon-sync] store error:", err));
  };

  ws.onerror = (event: Event) => {
    console.error(
      `[mastodon-sync] account ${conn.accountId} error:`,
      (event as ErrorEvent).message || event.type,
    );
  };

  ws.onclose = () => {
    conn.ws = null;
    if (conn.closed) return;
    const delay = conn.backoffMs;
    // Cap high (5 min): a healthy socket that blips reconnects in ~1s (backoff
    // resets on open), but an account with a revoked token or an instance with
    // streaming disabled would otherwise retry every 30s forever. The upgrade
    // error event doesn't expose the HTTP status, so we can't single out auth
    // failures — backing off hard is the cheap, self-healing compromise.
    conn.backoffMs = Math.min(conn.backoffMs * 2, 5 * 60 * 1000);
    console.warn(`[mastodon-sync] account ${conn.accountId} closed; reconnecting in ${delay}ms`);
    setTimeout(() => {
      connect(conn).catch((err) => console.error("[mastodon-sync] reconnect error:", err));
    }, delay);
  };
}

// Reconcile live connections against the set of connected Mastodon accounts:
// open sockets for new accounts, tear down sockets for removed ones.
async function syncAccounts(): Promise<void> {
  const accounts = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.platform, "mastodon"));

  const present = new Set<number>();
  for (const a of accounts) {
    if (!a.accessToken || !a.instanceUrl) continue;
    present.add(a.id);
    if (!conns.has(a.id)) {
      const conn: Conn = {
        accountId: a.id,
        userId: a.userId,
        instanceHost: new URL(a.instanceUrl).hostname,
        ws: null,
        backoffMs: 1000,
        closed: false,
      };
      conns.set(a.id, conn);
      connect(conn).catch((err) => console.error("[mastodon-sync] connect error:", err));
    }
  }

  for (const [id, conn] of conns) {
    if (!present.has(id)) {
      conn.closed = true;
      try {
        conn.ws?.close();
      } catch {
        // ignore
      }
      conns.delete(id);
      console.log(`[mastodon-sync] account ${id} removed; socket closed`);
    }
  }

  console.log(`[mastodon-sync] ${conns.size} account stream(s) active`);
}

export async function startMastodonSync(): Promise<void> {
  await syncAccounts();
  setInterval(() => {
    syncAccounts().catch((err) => console.error("[mastodon-sync] account sync error:", err));
  }, ACCOUNT_REFRESH_MS);
}
