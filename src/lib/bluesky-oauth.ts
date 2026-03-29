import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import type { Agent } from "@atproto/api";

let cachedClient: BrowserOAuthClient | null = null;
let cachedClientId: string | null = null;
let cachedAgent: Agent | null = null;
let restorePromise: Promise<Agent | null> | null = null;

// Store/retrieve the authenticated agent so it survives across component mounts
export function setBlueskyAgent(agent: Agent | null) {
  cachedAgent = agent;
}

export function getBlueskyAgent(): Agent | null {
  return cachedAgent;
}

// RFC 8252: AT Protocol requires loopback IP, not "localhost"
export function ensureLoopbackIp(): boolean {
  if (window.location.hostname === "localhost") {
    window.location.hostname = "127.0.0.1";
    return true; // navigating away
  }
  return false;
}

export async function getBlueskyOAuthClient(): Promise<BrowserOAuthClient> {
  if (ensureLoopbackIp()) {
    // Will never resolve — page is navigating
    return new Promise(() => {});
  }

  const { BrowserOAuthClient } = await import("@atproto/oauth-client-browser");

  const origin = window.location.origin;
  const redirectUri = `${origin}/login`;
  const isLocalhost = window.location.hostname === "127.0.0.1";

  let clientId: string;

  if (isLocalhost) {
    // Reuse cached CIMD client ID to avoid re-registering every time.
    // Persist in localStorage so it survives page reloads — otherwise
    // session restoration fails because the client_id no longer matches.
    const storageKey = `alpaca_cimd_client_id_${redirectUri}`;
    const stored = localStorage.getItem(storageKey);
    if (cachedClientId) {
      clientId = cachedClientId;
    } else if (stored) {
      clientId = stored;
      cachedClientId = stored;
    } else {
      const cimdRes = await fetch("https://cimd-service.fly.dev/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "alpaca.blue",
          client_uri: origin,
          redirect_uris: [redirectUri],
          scope: "atproto transition:generic",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "web",
          dpop_bound_access_tokens: true,
        }),
      });
      if (!cimdRes.ok)
        throw new Error("Failed to register OAuth client with CIMD service");
      const cimdData = await cimdRes.json();
      clientId = cimdData.client_id;
      cachedClientId = clientId;
      localStorage.setItem(storageKey, clientId);
    }
  } else {
    clientId = `${origin}/api/client-metadata`;
  }

  if (cachedClient) return cachedClient;

  const client = new BrowserOAuthClient({
    clientMetadata: {
      client_id: clientId,
      client_name: "alpaca.blue",
      client_uri: origin,
      redirect_uris: [redirectUri],
      scope: "atproto transition:generic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      dpop_bound_access_tokens: true,
    },
    handleResolver: "https://bsky.social",
  });

  cachedClient = client;
  return client;
}

// Restore an existing Bluesky session.
// client.init() is only for handling the OAuth redirect callback (URL has ?code=).
// On all other page loads, call client.restore(did) directly.
// Calling both causes "refresh token replayed" because init() consumes the
// refresh token even when it returns undefined.
export function restoreBlueskySession(): Promise<Agent | null> {
  if (restorePromise) return restorePromise;
  restorePromise = _restoreBlueskySession().finally(() => { restorePromise = null; });
  return restorePromise;
}

async function _restoreBlueskySession(): Promise<Agent | null> {
  const { Agent } = await import("@atproto/api");
  const client = await getBlueskyOAuthClient();

  const isOAuthCallback = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("code");

  if (isOAuthCallback) {
    // Handle the redirect — init() exchanges the code for tokens
    const result = await client.init();
    if (result?.session) {
      const agent = new Agent(result.session);
      setBlueskyAgent(agent);
      return agent;
    }
    return null;
  }

  // Normal page load — restore session directly using the DID from server session
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return null;
    const { blueskyDid } = await res.json();
    if (!blueskyDid) return null;

    const session = await client.restore(blueskyDid);
    const agent = new Agent(session);
    setBlueskyAgent(agent);
    return agent;
  } catch (err) {
    console.error("[bluesky] restore(did) failed:", err);
    return null;
  }
}

// Clear stale DPoP keys and session data from browser storage
// so a fresh OAuth flow can start cleanly
export async function clearBlueskySession() {
  cachedClient = null;
  cachedClientId = null;

  // Clear any CIMD client IDs from localStorage
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && key.startsWith("alpaca_cimd_client_id")) {
      localStorage.removeItem(key);
    }
  }

  // The library stores DPoP keys and session data in IndexedDB
  const databases = await indexedDB.databases();
  for (const dbInfo of databases) {
    if (dbInfo.name && dbInfo.name.includes("atproto")) {
      indexedDB.deleteDatabase(dbInfo.name);
    }
  }
}
