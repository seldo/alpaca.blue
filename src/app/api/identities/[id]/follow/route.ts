import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { platformIdentities, connectedAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { getServerBlueskyAgent } from "@/lib/bluesky-server";
import { redis, KEY_PREFIX } from "@/lib/redis";
import { extractBlueskyFollowUri, parseRawProfile } from "@/lib/profile-meta";

// Toggle follow state for a stored identity. POST = follow, DELETE = unfollow.
// On success we bust the per-identity profile-fetch TTL so the next page load
// re-pulls rawProfile and the UI reflects fresh viewer/relationship state.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handle(request, params, "follow");
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handle(request, params, "unfollow");
}

async function handle(
  _request: NextRequest,
  paramsPromise: Promise<{ id: string }>,
  action: "follow" | "unfollow",
) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();
    const userId = session.userId!;

    const { id } = await paramsPromise;
    const identityId = parseInt(id);
    if (isNaN(identityId)) {
      return NextResponse.json({ error: "Invalid identity ID" }, { status: 400 });
    }

    const [identity] = await db
      .select()
      .from(platformIdentities)
      .where(and(eq(platformIdentities.id, identityId), eq(platformIdentities.userId, userId)))
      .limit(1);

    if (!identity) {
      return NextResponse.json({ error: "Identity not found" }, { status: 404 });
    }

    if (identity.platform === "bluesky") {
      if (!identity.did) {
        return NextResponse.json({ error: "Identity missing DID" }, { status: 400 });
      }
      const agent = await getServerBlueskyAgent(userId);
      if (!agent) return NextResponse.json({ error: "Bluesky session not found" }, { status: 401 });

      if (action === "follow") {
        await agent.follow(identity.did);
      } else {
        // The follow URI sits at viewer.following on the user's view of this
        // profile. Re-fetch to be sure we have it (the stored rawProfile may
        // be stale or not include viewer state yet).
        const profile = await agent.getProfile({ actor: identity.did });
        const followUri = extractBlueskyFollowUri(profile.data);
        if (followUri) {
          await agent.deleteFollow(followUri);
        }
      }
    } else if (identity.platform === "mastodon") {
      const [account] = await db
        .select()
        .from(connectedAccounts)
        .where(and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.platform, "mastodon"),
        ))
        .limit(1);
      if (!account?.accessToken || !account.instanceUrl) {
        return NextResponse.json({ error: "Mastodon account not connected" }, { status: 400 });
      }

      // Need the Mastodon account ID (not handle) to call follow/unfollow.
      const raw = parseRawProfile(identity.rawProfile);
      let accountId = raw && typeof raw.id === "string" ? raw.id : null;
      if (!accountId) {
        const lookupRes = await fetch(
          `${account.instanceUrl}/api/v1/accounts/lookup?acct=${encodeURIComponent(identity.handle.replace(/^@/, ""))}`,
          { headers: { Authorization: `Bearer ${account.accessToken}` } },
        );
        if (lookupRes.ok) {
          const data = await lookupRes.json();
          if (typeof data.id === "string") accountId = data.id;
        }
      }
      if (!accountId) {
        return NextResponse.json({ error: "Could not resolve Mastodon account" }, { status: 502 });
      }

      const path = action === "follow" ? "follow" : "unfollow";
      const res = await fetch(
        `${account.instanceUrl}/api/v1/accounts/${encodeURIComponent(accountId)}/${path}`,
        { method: "POST", headers: { Authorization: `Bearer ${account.accessToken}` } },
      );
      if (!res.ok) {
        const text = await res.text();
        console.error("[mastodon follow] failed:", res.status, text);
        return NextResponse.json({ error: `Mastodon ${path} failed` }, { status: 502 });
      }
    } else {
      return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
    }

    await db
      .update(platformIdentities)
      .set({ isFollowed: action === "follow" })
      .where(eq(platformIdentities.id, identityId));

    // Bust the profile-fetch debounce so the next /posts call re-fetches and
    // picks up the new viewer state.
    await redis.del(`${KEY_PREFIX}identity:profile_fetched:${identityId}`).catch(() => {});

    return NextResponse.json({ ok: true, isFollowing: action === "follow" });
  } catch (err) {
    console.error("[follow toggle] error:", err);
    const message = err instanceof Error ? err.message : "Failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
