import { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { NodeSavedState, NodeSavedSession } from "@atproto/oauth-client-node";
import { Agent } from "@atproto/api";
import { redis, KEY_PREFIX } from "./redis";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

// ── Redis-backed stores ────────────────────────────────────────────────────

const stateStore = {
  async get(key: string): Promise<NodeSavedState | undefined> {
    const val = await redis.get<NodeSavedState>(`${KEY_PREFIX}bluesky:state:${key}`).catch(() => null);
    return val ?? undefined;
  },
  async set(key: string, value: NodeSavedState): Promise<void> {
    await redis.set(`${KEY_PREFIX}bluesky:state:${key}`, value, { ex: 600 }).catch(() => {}); // 10 min
  },
  async del(key: string): Promise<void> {
    await redis.del(`${KEY_PREFIX}bluesky:state:${key}`).catch(() => {});
  },
};

const sessionStore = {
  async get(key: string): Promise<NodeSavedSession | undefined> {
    const val = await redis.get<NodeSavedSession>(`${KEY_PREFIX}bluesky:session:${key}`).catch(() => null);
    return val ?? undefined;
  },
  async set(key: string, value: NodeSavedSession): Promise<void> {
    // No TTL — sessions last until revoked or DID is deleted
    await redis.set(`${KEY_PREFIX}bluesky:session:${key}`, value).catch(() => {});
  },
  async del(key: string): Promise<void> {
    await redis.del(`${KEY_PREFIX}bluesky:session:${key}`).catch(() => {});
  },
};

// ── Distributed Redis lock (replaces requestLocalLock for serverless) ─────
// Bluesky uses one-time-use refresh tokens. requestLocalLock only prevents
// races within a single process, but Netlify runs each request in its own
// serverless instance. Without a distributed lock, concurrent requests from
// two devices can both try to consume the same refresh token — one succeeds,
// the other gets "token already used", and the library deletes the session,
// forcing re-auth.

async function requestRedisLock<T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> {
  const lockKey = `${KEY_PREFIX}lock:${name}`;
  const lockId = Math.random().toString(36).slice(2);
  const deadline = Date.now() + 15_000; // wait up to 15s to acquire

  while (Date.now() < deadline) {
    const acquired = await redis.set(lockKey, lockId, { nx: true, ex: 30 }).catch(() => null);
    if (acquired) {
      try {
        return await fn();
      } finally {
        const current = await redis.get<string>(lockKey).catch(() => null);
        if (current === lockId) await redis.del(lockKey).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 100));
  }
  throw new Error(`[bluesky-server] Could not acquire distributed lock: ${name}`);
}

// ── Singleton client ──────────────────────────────────────────────────────

let _client: NodeOAuthClient | null = null;
let _clientInitPromise: Promise<NodeOAuthClient> | null = null;

function getAppUrl(): string {
  return (process.env.APP_URL || "https://alpaca.blue").replace(/\/$/, "");
}

function isLocalhostUrl(url: string): boolean {
  return url.includes("127.0.0.1") || url.includes("localhost");
}

async function resolveClientId(appUrl: string, redirectUri: string): Promise<string> {
  if (!isLocalhostUrl(appUrl)) {
    return `${appUrl}/api/client-metadata`;
  }

  // For localhost dev: use CIMD service (same as browser), cached in Redis
  const cacheKey = `${KEY_PREFIX}bluesky:client_id:${redirectUri}`;
  const cached = await redis.get<string>(cacheKey).catch(() => null);
  if (cached) return cached;

  const cimdRes = await fetch("https://cimd-service.fly.dev/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "alpaca.blue (server)",
      client_uri: appUrl,
      redirect_uris: [redirectUri],
      scope: "atproto transition:generic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      dpop_bound_access_tokens: true,
    }),
  });
  if (!cimdRes.ok) throw new Error("Failed to register OAuth client with CIMD");
  const { client_id: clientId } = await cimdRes.json();
  await redis.set(cacheKey, clientId, { ex: 60 * 60 * 24 }).catch(() => {}); // 24h TTL
  return clientId;
}

async function createClient(): Promise<NodeOAuthClient> {
  const appUrl = getAppUrl();
  const redirectUri = `${appUrl}/api/auth/bluesky/callback`;
  const clientId = await resolveClientId(appUrl, redirectUri);

  return new NodeOAuthClient({
    clientMetadata: {
      client_id: clientId,
      client_name: "alpaca.blue",
      client_uri: appUrl,
      redirect_uris: [redirectUri],
      scope: "atproto transition:generic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      dpop_bound_access_tokens: true,
    },
    handleResolver: "https://bsky.social",
    stateStore,
    sessionStore,
    requestLock: requestRedisLock,
  });
}

export async function getNodeOAuthClient(): Promise<NodeOAuthClient> {
  if (_client) return _client;
  if (_clientInitPromise) return _clientInitPromise;
  _clientInitPromise = createClient().then((client) => {
    _client = client;
    _clientInitPromise = null;
    return client;
  });
  return _clientInitPromise;
}

// ── Server-side agent for a user ──────────────────────────────────────────

export async function getServerBlueskyAgent(userId: number): Promise<Agent | null> {
  const [user] = await db.select({ blueskyDid: users.blueskyDid }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.blueskyDid) return null;

  try {
    const client = await getNodeOAuthClient();
    const session = await client.restore(user.blueskyDid);
    return new Agent(session);
  } catch (err) {
    console.error("[bluesky-server] Failed to restore session for user", userId, err);
    return null;
  }
}
