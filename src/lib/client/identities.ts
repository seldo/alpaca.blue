// Client-side identity/person map. Downloads the server's matching results
// (the one thing that genuinely lives on the server) once per session and uses
// them to enrich posts and reactions: linking authors to their in-app identity
// (/identities/:id) or resolved person (/persons/:id), and collapsing
// cross-platform posts by the same person in the dedup pass.

import type { ClientPost } from "./types";
import type { Reactor } from "@/lib/reactions";
import { BlueskyClient } from "./bluesky";
import { fetchMastodonAuthorStatuses, type MastodonCredentials } from "./mastodon";

export interface IdentityInfo {
  id: number; // platformIdentities.id
  personId: number | null;
  personDisplayName: string | null;
}

export interface IdentityMap {
  byHandle: Map<string, IdentityInfo>;
  // Normalized handles of the viewer's own connected accounts (see normHandle).
  myHandles: Set<string>;
}

type RawIdentity = { id: number; personId: number | null; handle: string };

// Normalizes a handle for "is this me?" matching: lowercase, no leading @.
// Bluesky handles are bare ("seldo.com"); Mastodon are "@user@instance".
function normHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/^@/, "");
}

let mapPromise: Promise<IdentityMap> | null = null;

async function loadMap(): Promise<IdentityMap> {
  const byHandle = new Map<string, IdentityInfo>();
  const myHandles = new Set<string>();
  const [identitiesRes, accountsRes] = await Promise.allSettled([
    fetch("/api/graph/identities"),
    fetch("/api/accounts"),
  ]);
  try {
    if (identitiesRes.status === "fulfilled" && identitiesRes.value.ok) {
      const data = await identitiesRes.value.json();
      const personName = new Map<number, string | null>();
      for (const p of data.persons || []) personName.set(p.id, p.displayName ?? null);
      const all: RawIdentity[] = [
        ...(data.persons || []).flatMap((p: { identities?: RawIdentity[] }) => p.identities || []),
        ...(data.unlinked || []),
      ];
      for (const i of all) {
        byHandle.set(i.handle, {
          id: i.id,
          personId: i.personId ?? null,
          personDisplayName: i.personId ? personName.get(i.personId) ?? null : null,
        });
      }
    }
  } catch (err) {
    console.error("[identities] map load failed:", err);
  }
  try {
    if (accountsRes.status === "fulfilled" && accountsRes.value.ok) {
      const accounts: Array<{ handle?: string }> = await accountsRes.value.json();
      for (const a of accounts) if (a.handle) myHandles.add(normHandle(a.handle));
    }
  } catch (err) {
    console.error("[identities] accounts load failed:", err);
  }
  return { byHandle, myHandles };
}

// Cached for the session (the matching results change rarely). Pass force after
// a manual re-resolve to pick up new links.
export function getIdentityMap(force = false): Promise<IdentityMap> {
  if (!mapPromise || force) mapPromise = loadMap();
  return mapPromise;
}

// Links a post's author to its in-app identity + resolved person. Handles match
// across platforms: Bluesky uses the plain handle, Mastodon uses @user@instance,
// which is exactly how platformIdentities stores them.
export function enrichAuthor(post: ClientPost, map: IdentityMap): void {
  if (!post.author) return;
  if (map.myHandles.has(normHandle(post.author.handle))) post.author.isSelf = true;
  const info = map.byHandle.get(post.author.handle);
  if (!info) return;
  post.author.id = info.id;
  post.person = info.personId
    ? { id: info.personId, displayName: info.personDisplayName }
    : null;
}

export function enrichReactor(reactor: Reactor, map: IdentityMap): void {
  const info = map.byHandle.get(reactor.handle);
  if (!info) return;
  reactor.platformIdentityId = info.id;
  reactor.personId = info.personId;
}

// Fetches a page of one linked identity's posts directly from its platform.
// Returns the page + a cursor for the next page. Used by the person / identity
// pages instead of a server posts route. Mastodon identities store the account
// id in `did`.
export async function fetchPostsForIdentity(
  identity: { platform: string; did: string | null; handle: string },
  clients: { bluesky: BlueskyClient | null; mastodon: MastodonCredentials | null },
  opts: { cursor?: string; filter?: string } = {},
): Promise<{ posts: ClientPost[]; cursor: string | null }> {
  if (identity.platform === "bluesky" && clients.bluesky) {
    return clients.bluesky.getAuthorFeed(identity.did || identity.handle, {
      cursor: opts.cursor,
      filter: opts.filter,
    });
  }
  if (identity.platform === "mastodon" && clients.mastodon && identity.did) {
    return fetchMastodonAuthorStatuses(clients.mastodon, identity.did, { maxId: opts.cursor });
  }
  return { posts: [], cursor: null };
}
