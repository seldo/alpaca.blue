// Client-side Mastodon access. Fetches directly from the user's instance using
// the bearer token brokered by /api/accounts/credentials — no server hop. This
// is the client analogue of the fetch functions in src/lib/posts.ts.

import type { ClientPost } from "./types";
import type { RawReaction } from "@/lib/reactions";
import { mapMastodonStatus, stripHtmlTags, type MastodonStatus } from "./transform";
import { attachDedupeHashes } from "./dedup";

export interface MastodonCredentials {
  handle: string;
  accountId: string | null;
  instanceUrl: string;
  accessToken: string;
}

// Loads the user's Mastodon credentials (token + instance) from the server.
// Returns null when no Mastodon account is connected.
export async function getMastodonCredentials(): Promise<MastodonCredentials | null> {
  const res = await fetch("/api/accounts/credentials");
  if (!res.ok) return null;
  const data = await res.json();
  return data.mastodon ?? null;
}

// Fetches the home timeline and maps it to ClientPosts (with dedupe hashes).
export async function fetchMastodonHomeTimeline(
  creds: MastodonCredentials,
  { limit = 40 }: { limit?: number } = {},
): Promise<ClientPost[]> {
  const instanceHost = new URL(creds.instanceUrl).hostname;
  const res = await fetch(
    `${creds.instanceUrl}/api/v1/timelines/home?limit=${limit}`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Mastodon timeline fetch failed: ${res.status}`);
  }
  const statuses: MastodonStatus[] = await res.json();
  const mapped = statuses.map((s) => mapMastodonStatus(s, instanceHost));
  return attachDedupeHashes(mapped);
}

// Fetches @-mentions (notifications, type=mention) as mention ClientPosts.
export async function fetchMastodonMentions(
  creds: MastodonCredentials,
  { limit = 40 }: { limit?: number } = {},
): Promise<ClientPost[]> {
  const instanceHost = new URL(creds.instanceUrl).hostname;
  const res = await fetch(
    `${creds.instanceUrl}/api/v1/notifications?types[]=mention&limit=${limit}`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } },
  );
  if (!res.ok) throw new Error(`Mastodon mentions fetch failed: ${res.status}`);
  const notifications: Array<{ status: MastodonStatus | null }> = await res.json();
  const mapped = notifications
    .map((n) => n.status)
    .filter((s): s is MastodonStatus => !!s)
    .map((s) => {
      const cp = mapMastodonStatus(s, instanceHost);
      cp.replyToMe = !!cp.replyToId;
      return cp;
    });
  return attachDedupeHashes(mapped);
}

// Fetches favourite/reblog/follow notifications as RawReactions. subjectUrl
// points at the status on its instance; reactor identity links are left null
// (ReactionCard routes those through /identities/lookup).
export async function fetchMastodonReactions(
  creds: MastodonCredentials,
  { limit = 50 }: { limit?: number } = {},
): Promise<RawReaction[]> {
  const instanceHost = new URL(creds.instanceUrl).hostname;
  const res = await fetch(
    `${creds.instanceUrl}/api/v1/notifications?types[]=favourite&types[]=reblog&types[]=follow&limit=${limit}`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } },
  );
  if (!res.ok) throw new Error(`Mastodon reactions fetch failed: ${res.status}`);
  const notifications: Array<{
    type: string;
    created_at: string;
    account: { acct: string; display_name: string; username: string; avatar: string };
    status?: { url: string; content: string } | null;
  }> = await res.json();

  return notifications
    .filter((n) => n.type === "favourite" || n.type === "reblog" || n.type === "follow")
    .map((n) => {
      const handle = n.account.acct.includes("@")
        ? `@${n.account.acct}`
        : `@${n.account.acct}@${instanceHost}`;
      const reactionType = n.type === "favourite" ? "like" : n.type === "reblog" ? "repost" : "follow";
      return {
        platform: "mastodon" as const,
        reactionType: reactionType as "like" | "repost" | "follow",
        subjectId: null,
        subjectExcerpt: n.status ? stripHtmlTags(n.status.content) : null,
        subjectUrl: n.status?.url ?? null,
        reactor: {
          handle,
          displayName: n.account.display_name || n.account.username,
          avatarUrl: n.account.avatar,
          platformIdentityId: null,
          personId: null,
        },
        reactedAt: n.created_at,
      };
    });
}

export interface MastodonAccountView {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  header: string;
  note: string;
  url: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
}

// Resolves a @user@instance handle to its account (via webfinger), for viewing
// any actor's profile — including ones the user doesn't follow.
export async function lookupMastodonAccount(
  creds: MastodonCredentials,
  handle: string,
): Promise<MastodonAccountView | null> {
  const acct = handle.replace(/^@/, "");
  const headers = { Authorization: `Bearer ${creds.accessToken}` };

  // Fast path: accounts the instance already knows. /lookup is local-only — it
  // does NOT WebFinger unknown remote accounts, so it 404s for those.
  const res = await fetch(
    `${creds.instanceUrl}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
    { headers },
  );
  if (res.ok) return res.json();

  // Fallback: search with resolve=true WebFingers the remote account and pulls
  // it in. Match the exact acct so we don't return a fuzzy hit. A handle on the
  // viewer's own instance comes back as a bare username, so accept that too.
  const searchRes = await fetch(
    `${creds.instanceUrl}/api/v2/search?q=${encodeURIComponent(acct)}&type=accounts&resolve=true&limit=5`,
    { headers },
  );
  if (!searchRes.ok) return null;
  const data = await searchRes.json();
  const accounts: MastodonAccountView[] = data.accounts || [];
  const want = acct.toLowerCase();
  const instanceHost = new URL(creds.instanceUrl).hostname.toLowerCase();
  const wantLocal = want.endsWith(`@${instanceHost}`)
    ? want.slice(0, -(instanceHost.length + 1))
    : want;
  return (
    accounts.find((a) => {
      const got = a.acct.toLowerCase();
      return got === want || got === wantLocal;
    }) ?? null
  );
}

// Resolves a status by its URL (any instance) via search, for cross-post mirror
// targets. resolve=true makes the user's instance fetch a remote status.
export async function searchMastodonStatus(
  creds: MastodonCredentials,
  url: string,
): Promise<MastodonStatus | null> {
  const res = await fetch(
    `${creds.instanceUrl}/api/v2/search?q=${encodeURIComponent(url)}&resolve=true&type=statuses&limit=1`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data.statuses || [])[0] ?? null;
}

// Fetches a status + its thread context (ancestors + descendants) for the
// detail view.
export async function fetchMastodonThread(
  creds: MastodonCredentials,
  statusId: string,
): Promise<{ ancestors: ClientPost[]; main: ClientPost | null; replies: ClientPost[] }> {
  const instanceHost = new URL(creds.instanceUrl).hostname;
  const headers = { Authorization: `Bearer ${creds.accessToken}` };
  const [statusRes, ctxRes] = await Promise.all([
    fetch(`${creds.instanceUrl}/api/v1/statuses/${statusId}`, { headers }),
    fetch(`${creds.instanceUrl}/api/v1/statuses/${statusId}/context`, { headers }),
  ]);
  if (!statusRes.ok) throw new Error(`Mastodon status fetch failed: ${statusRes.status}`);
  const main = mapMastodonStatus(await statusRes.json(), instanceHost);

  let ancestors: ClientPost[] = [];
  let replies: ClientPost[] = [];
  if (ctxRes.ok) {
    const ctx = await ctxRes.json();
    ancestors = (ctx.ancestors || []).map((s: MastodonStatus) => mapMastodonStatus(s, instanceHost));
    replies = (ctx.descendants || []).map((s: MastodonStatus) => mapMastodonStatus(s, instanceHost));
  }
  await attachDedupeHashes([main, ...ancestors, ...replies]);
  return { ancestors, main, replies };
}

// Fetches a page of an account's statuses by account id (Mastodon identities
// store the account id in `did`). Skips reblogs. Returns the page + a cursor
// (the oldest status id, for max_id paging). `excludeReplies` / `onlyMedia`
// drive the identity-page tabs.
export async function fetchMastodonAuthorStatuses(
  creds: MastodonCredentials,
  accountId: string,
  opts: { excludeReplies?: boolean; onlyMedia?: boolean; maxId?: string; limit?: number } = {},
): Promise<{ posts: ClientPost[]; cursor: string | null }> {
  const instanceHost = new URL(creds.instanceUrl).hostname;
  const qs = new URLSearchParams({ limit: String(opts.limit ?? 40) });
  if (opts.excludeReplies) qs.set("exclude_replies", "true");
  if (opts.onlyMedia) qs.set("only_media", "true");
  if (opts.maxId) qs.set("max_id", opts.maxId);
  const res = await fetch(`${creds.instanceUrl}/api/v1/accounts/${accountId}/statuses?${qs}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!res.ok) return { posts: [], cursor: null };
  const statuses: MastodonStatus[] = await res.json();
  const posts = await attachDedupeHashes(
    statuses.filter((s) => !s.reblog).map((s) => mapMastodonStatus(s, instanceHost)),
  );
  return { posts, cursor: statuses.length > 0 ? statuses[statuses.length - 1].id : null };
}

// Fetches an account entity by id (stats, banner, note) for the identity header.
export async function fetchMastodonAccountById(
  creds: MastodonCredentials,
  id: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${creds.instanceUrl}/api/v1/accounts/${id}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// Returns whether the viewer follows this account, or null on failure.
export async function fetchMastodonRelationship(
  creds: MastodonCredentials,
  id: string,
): Promise<boolean | null> {
  const res = await fetch(
    `${creds.instanceUrl}/api/v1/accounts/relationships?id[]=${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } },
  );
  if (!res.ok) return null;
  const arr = await res.json();
  return Array.isArray(arr) && arr[0]?.following === true;
}

export async function mastodonFollow(
  creds: MastodonCredentials,
  accountId: string,
  undo: boolean,
): Promise<void> {
  const path = undo ? "unfollow" : "follow";
  const res = await fetch(`${creds.instanceUrl}/api/v1/accounts/${accountId}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!res.ok) throw new Error(`Mastodon ${path} failed: ${res.status}`);
}

// Fetches the user's own posts (for the profile feed).
export async function fetchMastodonOwnStatuses(
  creds: MastodonCredentials,
  { limit = 40 }: { limit?: number } = {},
): Promise<ClientPost[]> {
  if (!creds.accountId) return [];
  const instanceHost = new URL(creds.instanceUrl).hostname;
  const res = await fetch(
    `${creds.instanceUrl}/api/v1/accounts/${creds.accountId}/statuses?limit=${limit}&exclude_replies=false`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } },
  );
  if (!res.ok) throw new Error(`Mastodon own statuses fetch failed: ${res.status}`);
  const statuses: MastodonStatus[] = await res.json();
  return attachDedupeHashes(statuses.map((s) => mapMastodonStatus(s, instanceHost)));
}

// ── Writes ─────────────────────────────────────────────────

// Favourite / unfavourite a status. Returns the platform's authoritative state.
export async function mastodonFavourite(
  creds: MastodonCredentials,
  statusId: string,
  undo: boolean,
): Promise<{ viewerLiked: boolean; likeCount: number }> {
  const endpoint = undo ? "unfavourite" : "favourite";
  const res = await fetch(`${creds.instanceUrl}/api/v1/statuses/${statusId}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!res.ok) throw new Error(`Mastodon ${endpoint} failed: ${res.status}`);
  const s = await res.json();
  return { viewerLiked: !!s.favourited, likeCount: s.favourites_count ?? 0 };
}

// Reblog / unreblog a status. On reblog the API returns the wrapper whose inner
// `reblog` carries the updated count; on unreblog it returns the original.
export async function mastodonReblog(
  creds: MastodonCredentials,
  statusId: string,
  undo: boolean,
): Promise<{ viewerReposted: boolean; repostCount: number }> {
  const endpoint = undo ? "unreblog" : "reblog";
  const res = await fetch(`${creds.instanceUrl}/api/v1/statuses/${statusId}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!res.ok) throw new Error(`Mastodon ${endpoint} failed: ${res.status}`);
  const s = await res.json();
  const target = s.reblog || s;
  return { viewerReposted: !undo, repostCount: target.reblogs_count ?? 0 };
}

// Uploads media to v2/media, polling v1/media/:id while the server processes it
// (202). Returns the media id to attach to a status.
export async function mastodonUploadMedia(
  creds: MastodonCredentials,
  file: File,
  alt: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  if (alt) form.append("description", alt);
  const res = await fetch(`${creds.instanceUrl}/api/v2/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Mastodon media upload failed: ${res.status}`);
  const media = await res.json();
  if (res.status === 202) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(`${creds.instanceUrl}/api/v1/media/${media.id}`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      if (poll.ok) {
        const polled = await poll.json();
        if (polled.url) return polled.id;
      }
    }
    throw new Error("Mastodon media processing timed out");
  }
  return media.id;
}

export async function mastodonPostStatus(
  creds: MastodonCredentials,
  opts: { status: string; inReplyToId?: string; mediaIds?: string[] },
): Promise<{ id: string; url: string }> {
  const res = await fetch(`${creds.instanceUrl}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      status: opts.status,
      ...(opts.mediaIds && opts.mediaIds.length > 0 ? { media_ids: opts.mediaIds } : {}),
      ...(opts.inReplyToId ? { in_reply_to_id: opts.inReplyToId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Mastodon post failed: ${res.status}`);
  const s = await res.json();
  return { id: s.id, url: s.url };
}

// Mastodon convention: replies must @-prefix the parent author or they aren't
// threaded/notified. Returns the prefix mention, or null when not needed
// (replying to self, or the author is already mentioned at the start). Ported
// from the /api/posts/create server helper.
export async function mastodonReplyPrefix(
  creds: MastodonCredentials,
  inReplyToId: string,
  content: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${creds.instanceUrl}/api/v1/statuses/${inReplyToId}`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!res.ok) return null;
    const status = (await res.json()) as { account?: { acct?: string } };
    const acct = status.account?.acct;
    if (!acct) return null;
    const ownInstance = new URL(creds.instanceUrl).hostname;
    const fullAcct = acct.includes("@") ? acct : `${acct}@${ownInstance}`;
    const ownNormalized = creds.handle.replace(/^@/, "");
    if (fullAcct.toLowerCase() === ownNormalized.toLowerCase()) return null;
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^@${escapeRegex(acct)}\\b`, "i").test(content.trim())) return null;
    return `@${acct}`;
  } catch (err) {
    console.error("[mastodonReplyPrefix] lookup failed:", err);
    return null;
  }
}
