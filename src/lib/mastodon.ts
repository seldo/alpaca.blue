import { db } from "@/db";
import { connectedAccounts, platformIdentities } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";

interface MastodonApp {
  client_id: string;
  client_secret: string;
}

interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  note: string;
  url: string;
}

function getRedirectUri(appOrigin: string) {
  return `${appOrigin}/api/auth/mastodon/callback`;
}

// Register an OAuth app with a Mastodon instance
export async function registerMastodonApp(
  instanceUrl: string,
  appOrigin: string
): Promise<MastodonApp> {
  const url = `${instanceUrl}/api/v1/apps`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "alpaca.blue",
      redirect_uris: getRedirectUri(appOrigin),
      scopes: "read write:favourites write:statuses write:media",
      website: "https://alpaca.blue",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to register app with ${instanceUrl}`);
  }

  return response.json();
}

// Generate the OAuth authorization URL
export function getMastodonAuthUrl(
  instanceUrl: string,
  clientId: string,
  appOrigin: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(appOrigin),
    response_type: "code",
    scope: "read write:favourites write:statuses write:media",
  });

  return `${instanceUrl}/oauth/authorize?${params.toString()}`;
}

// Exchange authorization code for access token
export async function exchangeMastodonToken(
  instanceUrl: string,
  clientId: string,
  clientSecret: string,
  code: string,
  appOrigin: string
): Promise<string> {
  const response = await fetch(`${instanceUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getRedirectUri(appOrigin),
      grant_type: "authorization_code",
      code,
      scope: "read write:favourites write:statuses write:media",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to exchange Mastodon token");
  }

  const data = await response.json();
  return data.access_token;
}

// Verify credentials and save the connected account
export async function saveMastodonAccount(
  instanceUrl: string,
  accessToken: string,
  userId: number
) {
  const response = await fetch(
    `${instanceUrl}/api/v1/accounts/verify_credentials`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error("Failed to verify Mastodon credentials");
  }

  const account: MastodonAccount = await response.json();
  const fullHandle = `@${account.username}@${new URL(instanceUrl).hostname}`;

  await db
    .insert(connectedAccounts)
    .values({
      userId,
      platform: "mastodon",
      handle: fullHandle,
      did: account.id,
      instanceUrl,
      accessToken,
    })
    .onDuplicateKeyUpdate({
      set: {
        did: account.id,
        accessToken,
        updatedAt: new Date(),
      },
    });

  return { handle: fullHandle, id: account.id };
}

// Fetch a page of follows with Link header pagination
async function fetchFollowsPage(
  instanceUrl: string,
  accessToken: string,
  url: string
): Promise<{ accounts: MastodonAccount[]; nextUrl: string | null }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch Mastodon follows");
  }

  const accounts: MastodonAccount[] = await response.json();

  // Parse Link header for pagination
  let nextUrl: string | null = null;
  const linkHeader = response.headers.get("Link");
  if (linkHeader) {
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      nextUrl = nextMatch[1];
    }
  }

  return { accounts, nextUrl };
}

export async function importMastodonFollows(userId: number) {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.platform, "mastodon")
      )
    )
    .limit(1);

  if (!account?.accessToken || !account.instanceUrl) {
    throw new Error("Not authenticated with Mastodon");
  }

  const instanceUrl = account.instanceUrl;
  const accessToken = account.accessToken;
  const instanceHost = new URL(instanceUrl).hostname;

  let url: string | null =
    `${instanceUrl}/api/v1/accounts/${account.did}/following?limit=80`;
  let imported = 0;

  while (url) {
    const { accounts, nextUrl } = await fetchFollowsPage(
      instanceUrl,
      accessToken,
      url
    );

    const rows = accounts.map((follow) => ({
      userId,
      platform: "mastodon" as const,
      handle: follow.acct.includes("@") ? `@${follow.acct}` : `@${follow.acct}@${instanceHost}`,
      did: follow.id,
      displayName: follow.display_name || null,
      avatarUrl: follow.avatar || null,
      bio: follow.note || null,
      profileUrl: follow.url,
      isFollowed: true,
      rawProfile: follow as unknown as Record<string, unknown>,
    }));

    if (rows.length > 0) {
      await db.insert(platformIdentities).values(rows).onDuplicateKeyUpdate({
        set: {
          did: sql`values(${platformIdentities.did})`,
          displayName: sql`values(${platformIdentities.displayName})`,
          avatarUrl: sql`values(${platformIdentities.avatarUrl})`,
          bio: sql`values(${platformIdentities.bio})`,
          isFollowed: true,
          rawProfile: sql`values(${platformIdentities.rawProfile})`,
          updatedAt: new Date(),
        },
      });
      imported += rows.length;
    }

    url = nextUrl;
  }

  await db
    .update(connectedAccounts)
    .set({ lastSyncAt: new Date() })
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.platform, "mastodon")
      )
    );

  return { imported };
}
