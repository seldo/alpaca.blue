import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import type { Agent } from "@atproto/api";

let cachedClient: BrowserOAuthClient | null = null;
let cachedClientId: string | null = null;
let cachedAgent: Agent | null = null;

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
  const redirectUri = `${origin}/`;
  const isLocalhost = window.location.hostname === "127.0.0.1";

  let clientId: string;

  if (isLocalhost) {
    // Reuse cached CIMD client ID to avoid re-registering every time.
    // Persist in localStorage so it survives page reloads — otherwise
    // session restoration fails because the client_id no longer matches.
    const storageKey = "alpaca_cimd_client_id";
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

// Clear stale DPoP keys and session data from browser storage
// so a fresh OAuth flow can start cleanly
export async function clearBlueskySession() {
  cachedClient = null;
  cachedClientId = null;
  localStorage.removeItem("alpaca_cimd_client_id");

  // The library stores DPoP keys and session data in IndexedDB
  const databases = await indexedDB.databases();
  for (const dbInfo of databases) {
    if (dbInfo.name && dbInfo.name.includes("atproto")) {
      indexedDB.deleteDatabase(dbInfo.name);
    }
  }
}
