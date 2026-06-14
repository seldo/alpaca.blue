// Client-side Bluesky access. The browser calls the user's PDS directly (XRPC
// is CORS-enabled), authenticating with a brokered access token + DPoP key (see
// /api/bluesky/credentials), signing its own DPoP proofs.
//
// Bluesky's PDS issues *secp256k1* (ES256K) DPoP keys, which WebCrypto's
// `subtle` can't handle (it only supports the NIST P-curves). So secp256k1
// signing goes through @noble/curves; P-256 keys (if a server ever issues one)
// fall back to WebCrypto. Either way the JWS signature is a raw r‖s pair, the
// JOSE wire format — no JWT library needed.
//
// Token *refresh* is delegated back to the server (POST .../refresh) so the
// one-time-use Bluesky refresh token stays server-owned and serialized.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { RichText } from "@atproto/api";
import type { ClientPost } from "./types";
import type { RawReaction } from "@/lib/reactions";
import { mapBlueskyFeedItem } from "./transform-bluesky";
import { attachDedupeHashes } from "./dedup";
import { expandBareDomains } from "@/lib/expand-bare-domains";

export interface BlueskyPostParams {
  text: string;
  replyTo?: { uri: string; cid: string };
  replyRoot?: { uri: string; cid: string };
  quote?: { uri: string; cid: string };
  images?: { image: unknown; alt: string }[]; // blob refs from uploadBlob
}

interface BlueskyCredentials {
  did: string;
  pdsUrl: string;
  accessToken: string;
  dpopPrivateJwk: JsonWebKey;
  expiresAt: string | null;
}

// ── base64url + JWT helpers ────────────────────────────────

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlText(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// First app.bsky.richtext.facet#link URI in a facet set, if any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstLinkFacet(facets: any[] | undefined): string | undefined {
  for (const facet of facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature?.$type === "app.bsky.richtext.facet#link" && typeof feature.uri === "string") {
        return feature.uri;
      }
    }
  }
  return undefined;
}
async function sha256b64url(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return b64url(digest);
}

// Reads the RFC 6750 error code out of a WWW-Authenticate challenge.
function wwwAuthError(res: Response): string | null {
  const m = (res.headers.get("WWW-Authenticate") || "").match(/error="([^"]+)"/);
  return m ? m[1] : null;
}

// ── Client ─────────────────────────────────────────────────

export class BlueskyClient {
  private creds: BlueskyCredentials;
  private alg = ""; // "ES256K" (secp256k1) | "ES256" (P-256)
  private publicJwk: JsonWebKey | null = null;
  private secpPriv: Uint8Array | null = null; // secp256k1 private scalar
  private webcryptoKey: CryptoKey | null = null; // P-256 signing key
  // The PDS issues a rotating DPoP nonce; we echo the latest one back. Tracked
  // in memory for the life of this client instance.
  private nonce: string | null = null;

  private constructor(creds: BlueskyCredentials) {
    this.creds = creds;
  }

  // Loads credentials and imports the DPoP key. Returns null when the user has
  // no Bluesky session.
  static async create(): Promise<BlueskyClient | null> {
    const res = await fetch("/api/bluesky/credentials");
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.bluesky) return null;
    const client = new BlueskyClient(data.bluesky);
    await client.importKey();
    return client;
  }

  private async importKey(): Promise<void> {
    const jwk = this.creds.dpopPrivateJwk;
    // The proof header embeds only the public EC params (kty/crv/x/y); the
    // server verifies the proof against them.
    this.publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };

    if (jwk.crv === "secp256k1") {
      this.alg = "ES256K";
      this.secpPriv = b64urlToBytes(jwk.d!); // 32-byte private scalar
    } else if (jwk.crv === "P-256") {
      this.alg = "ES256";
      this.webcryptoKey = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
    } else {
      throw new Error(`Unsupported DPoP key curve: ${jwk.crv}`);
    }
  }

  // Signs `header.payload` (ES256K via noble, or ES256 via WebCrypto) and
  // returns the compact JWS. Both paths emit a raw r‖s signature.
  private async signJwt(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
    const signingInput = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(payload))}`;
    let sig: Uint8Array;
    if (this.alg === "ES256K") {
      // prehash:true → noble applies secp256k1's SHA-256; lowS:true canonicalizes.
      sig = secp256k1.sign(new TextEncoder().encode(signingInput), this.secpPriv!, { lowS: true, prehash: true });
    } else {
      const raw = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.webcryptoKey!,
        new TextEncoder().encode(signingInput),
      );
      sig = new Uint8Array(raw);
    }
    return `${signingInput}.${b64url(sig)}`;
  }

  private async makeProof(method: string, url: URL): Promise<string> {
    const payload: Record<string, unknown> = {
      jti: crypto.randomUUID(),
      htm: method,
      htu: url.origin + url.pathname, // RFC 9449: no query/fragment
      iat: Math.floor(Date.now() / 1000),
      ath: await sha256b64url(this.creds.accessToken),
    };
    if (this.nonce) payload.nonce = this.nonce;
    return this.signJwt({ typ: "dpop+jwt", alg: this.alg, jwk: this.publicJwk! }, payload);
  }

  // Issues a DPoP-authenticated request to the PDS, transparently handling the
  // two recoverable 401s: `use_dpop_nonce` (retry with the nonce the server just
  // handed us) and `invalid_token` (refresh via the server, then retry). The
  // depth guard bounds retries — each recoverable error advances the token or
  // nonce, so it can't loop.
  private async request(
    method: string,
    pathname: string,
    opts: { json?: unknown; blob?: { data: Uint8Array; type: string } } = {},
    depth = 0,
  ): Promise<Response> {
    const url = new URL(pathname, this.creds.pdsUrl);
    const headers: Record<string, string> = {
      Authorization: `DPoP ${this.creds.accessToken}`,
      DPoP: await this.makeProof(method, url),
    };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.blob) {
      headers["Content-Type"] = opts.blob.type;
      body = opts.blob.data as unknown as BodyInit;
    }

    // DPoP proofs don't cover the body, so retries can reuse `opts` unchanged.
    const res = await fetch(url.toString(), { method, headers, body });

    const nonce = res.headers.get("DPoP-Nonce");
    if (nonce) this.nonce = nonce;

    if (res.status === 401 && depth < 4) {
      const err = wwwAuthError(res);
      if (err === "use_dpop_nonce") return this.request(method, pathname, opts, depth + 1);
      if (err === "invalid_token") {
        await this.refresh();
        return this.request(method, pathname, opts, depth + 1);
      }
    }
    return res;
  }

  get did(): string {
    return this.creds.did;
  }

  // Creates a record in the user's repo (likes, reposts, posts). Returns the
  // new record's AT URI + CID.
  private async createRecord(
    collection: string,
    record: Record<string, unknown>,
  ): Promise<{ uri: string; cid: string }> {
    const res = await this.request("POST", "/xrpc/com.atproto.repo.createRecord", {
      json: { repo: this.creds.did, collection, record },
    });
    if (!res.ok) throw new Error(`createRecord ${collection} failed: ${res.status}`);
    return res.json();
  }

  async like(uri: string, cid: string): Promise<{ uri: string; cid: string }> {
    return this.createRecord("app.bsky.feed.like", {
      subject: { uri, cid },
      createdAt: new Date().toISOString(),
    });
  }

  async repost(uri: string, cid: string): Promise<{ uri: string; cid: string }> {
    return this.createRecord("app.bsky.feed.repost", {
      subject: { uri, cid },
      createdAt: new Date().toISOString(),
    });
  }

  // Resolves a handle to a DID (for @-mention facets). Unauthenticated XRPC,
  // but we route it through the DPoP path for simplicity.
  async resolveHandle(handle: string): Promise<string> {
    const res = await this.request(
      "GET",
      `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    );
    if (!res.ok) throw new Error(`resolveHandle failed: ${res.status}`);
    return (await res.json()).did;
  }

  // Minimal agent shim for RichText.detectFacets — it only calls resolveHandle.
  private facetAgent() {
    return {
      resolveHandle: async ({ handle }: { handle: string }) => ({
        data: { did: await this.resolveHandle(handle) },
      }),
    };
  }

  async uploadBlob(file: File): Promise<unknown> {
    return this.uploadBlobBytes(new Uint8Array(await file.arrayBuffer()), file.type);
  }

  private async uploadBlobBytes(data: Uint8Array, type: string): Promise<unknown> {
    const res = await this.request("POST", "/xrpc/com.atproto.repo.uploadBlob", {
      blob: { data, type },
    });
    if (!res.ok) throw new Error(`uploadBlob failed: ${res.status}`);
    return (await res.json()).blob;
  }

  // Builds an app.bsky.embed.external for a bare-link post. The OG metadata +
  // thumb bytes come from the server (CORS); the thumb blob is uploaded here.
  private async buildExternalEmbed(uri: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`/api/bluesky/link-card?url=${encodeURIComponent(uri)}`);
      if (!res.ok) return null;
      const { card } = await res.json();
      if (!card) return null;
      let thumb: unknown;
      if (card.thumb) {
        thumb = await this.uploadBlobBytes(b64ToBytes(card.thumb.base64), card.thumb.mimeType);
      }
      return {
        $type: "app.bsky.embed.external",
        external: {
          uri: card.url,
          title: card.title || card.url,
          description: card.description || "",
          ...(thumb ? { thumb } : {}),
        },
      };
    } catch {
      return null;
    }
  }

  // Creates a feed post. Detects facets (URLs / #tags / @mentions) in the
  // browser via RichText, and — for a bare-link post (no images/quote) — attaches
  // a rich link-preview card (metadata from the server, thumb uploaded here).
  // Bluesky allows one embed per post, so images > quote > link card.
  async post(params: BlueskyPostParams): Promise<{ uri: string; cid: string }> {
    const rt = new RichText({ text: expandBareDomains(params.text.trim()) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await rt.detectFacets(this.facetAgent() as any);

    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
    };
    if (params.replyTo) {
      record.reply = { root: params.replyRoot ?? params.replyTo, parent: params.replyTo };
    }
    if (params.images && params.images.length > 0) {
      record.embed = { $type: "app.bsky.embed.images", images: params.images };
    } else if (params.quote) {
      record.embed = {
        $type: "app.bsky.embed.record",
        record: { uri: params.quote.uri, cid: params.quote.cid },
      };
    } else {
      const linkUri = firstLinkFacet(rt.facets);
      if (linkUri) {
        const external = await this.buildExternalEmbed(linkUri);
        if (external) record.embed = external;
      }
    }
    return this.createRecord("app.bsky.feed.post", record);
  }

  private async refresh(): Promise<void> {
    const res = await fetch("/api/bluesky/credentials/refresh", { method: "POST" });
    if (!res.ok) throw new Error("Bluesky session refresh failed");
    const data = await res.json();
    if (!data.bluesky) throw new Error("Bluesky session expired");
    // Only the access token rotates; the DPoP key (and thus signingKey) is
    // stable across refreshes.
    this.creds.accessToken = data.bluesky.accessToken;
    this.creds.expiresAt = data.bluesky.expiresAt;
  }

  // Fetches the home timeline and maps it to ClientPosts (with dedupe hashes).
  async getTimeline(limit = 50): Promise<ClientPost[]> {
    const res = await this.request("GET", `/xrpc/app.bsky.feed.getTimeline?limit=${limit}`);
    if (!res.ok) throw new Error(`Bluesky getTimeline failed: ${res.status}`);
    const data = await res.json();
    const items = (data.feed || []) as Parameters<typeof mapBlueskyFeedItem>[0][];
    return attachDedupeHashes(items.map(mapBlueskyFeedItem));
  }

  // Fetches a post + its thread (ancestor chain + direct replies) for the detail
  // view. Returns mapped ClientPosts.
  async getPostThread(
    uri: string,
  ): Promise<{ ancestors: ClientPost[]; main: ClientPost | null; replies: ClientPost[] }> {
    const res = await this.request(
      "GET",
      `/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=1&parentHeight=10`,
    );
    if (!res.ok) throw new Error(`Bluesky getPostThread failed: ${res.status}`);
    const thread = (await res.json()).thread;
    if (!thread?.post) return { ancestors: [], main: null, replies: [] };

    const main = mapBlueskyFeedItem({ post: thread.post });
    const ancestors: ClientPost[] = [];
    let parent = thread.parent;
    while (parent?.post) {
      ancestors.unshift(mapBlueskyFeedItem({ post: parent.post }));
      parent = parent.parent;
    }
    const replies: ClientPost[] = (thread.replies || [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((r: any) => r?.post)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => mapBlueskyFeedItem({ post: r.post }));

    await attachDedupeHashes([main, ...ancestors, ...replies]);
    return { ancestors, main, replies };
  }

  // Fetches a page of an author's feed (own profile or any actor). `filter` is
  // an app.bsky.feed.getAuthorFeed filter (e.g. posts_no_replies,
  // posts_with_media). Returns the page + a cursor for the next page.
  async getAuthorFeed(
    actor: string,
    opts: { filter?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ posts: ClientPost[]; cursor: string | null }> {
    const qs = new URLSearchParams({ actor, limit: String(opts.limit ?? 40) });
    if (opts.filter) qs.set("filter", opts.filter);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const res = await this.request("GET", `/xrpc/app.bsky.feed.getAuthorFeed?${qs}`);
    if (!res.ok) throw new Error(`Bluesky getAuthorFeed failed: ${res.status}`);
    const data = await res.json();
    const items = (data.feed || []) as Parameters<typeof mapBlueskyFeedItem>[0][];
    return {
      posts: await attachDedupeHashes(items.map(mapBlueskyFeedItem)),
      cursor: data.cursor || null,
    };
  }

  // Full profile view (stats, banner, viewer.following) for the identity page.
  async getProfile(actor: string): Promise<Record<string, unknown>> {
    const res = await this.request(
      "GET",
      `/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
    );
    if (!res.ok) throw new Error(`Bluesky getProfile failed: ${res.status}`);
    return res.json();
  }

  async follow(did: string): Promise<{ uri: string; cid: string }> {
    return this.createRecord("app.bsky.graph.follow", {
      subject: did,
      createdAt: new Date().toISOString(),
    });
  }

  // Deletes a record by AT URI (at://repo/collection/rkey). Used to unfollow
  // (the follow record's URI comes from the profile's viewer.following).
  async deleteRecord(uri: string): Promise<void> {
    const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m) return;
    const [, repo, collection, rkey] = m;
    const res = await this.request("POST", "/xrpc/com.atproto.repo.deleteRecord", {
      json: { repo, collection, rkey },
    });
    if (!res.ok) throw new Error(`deleteRecord failed: ${res.status}`);
  }

  // Fetches mentions/replies/quotes from notifications, hydrates the referenced
  // posts (getPosts, 25 at a time), and maps them as mention ClientPosts. Mirrors
  // the server's fetchAndStoreBlueskyMentions, but uses the fully-hydrated post
  // views directly so counts + viewer state come along for free.
  async getMentions(limit = 50): Promise<ClientPost[]> {
    const res = await this.request(
      "GET",
      `/xrpc/app.bsky.notification.listNotifications?limit=${limit}`,
    );
    if (!res.ok) throw new Error(`Bluesky listNotifications failed: ${res.status}`);
    const data = await res.json();
    const notifs = (data.notifications || []) as Array<{ reason: string; uri: string }>;
    const uris = [
      ...new Set(
        notifs
          .filter((n) => n.reason === "mention" || n.reason === "reply" || n.reason === "quote")
          .map((n) => n.uri),
      ),
    ];
    if (uris.length === 0) return [];

    const posts: Parameters<typeof mapBlueskyFeedItem>[0]["post"][] = [];
    for (let i = 0; i < uris.length; i += 25) {
      const qs = uris.slice(i, i + 25).map((u) => `uris[]=${encodeURIComponent(u)}`).join("&");
      const r = await this.request("GET", `/xrpc/app.bsky.feed.getPosts?${qs}`);
      if (!r.ok) continue;
      const pd = await r.json();
      posts.push(...(pd.posts || []));
    }

    const mapped = posts.map((post) => {
      const cp = mapBlueskyFeedItem({ post });
      cp.replyToMe = !!cp.replyToId;
      return cp;
    });
    return attachDedupeHashes(mapped);
  }

  // Fetches like/repost/follow notifications as RawReactions. Subject post text
  // (for like/repost) is hydrated via getPosts; subjectUrl points at the post on
  // bsky.app (we have no internal post id client-side). Reactor identity links
  // are left null — ReactionCard routes those through /identities/lookup.
  async getReactions(limit = 50): Promise<RawReaction[]> {
    const res = await this.request(
      "GET",
      `/xrpc/app.bsky.notification.listNotifications?limit=${limit}`,
    );
    if (!res.ok) throw new Error(`Bluesky listNotifications failed: ${res.status}`);
    const data = await res.json();
    const notifs = (data.notifications || []) as Array<{
      reason: string;
      reasonSubject?: string;
      author: { did: string; handle: string; displayName?: string; avatar?: string };
      indexedAt: string;
    }>;
    const reacts = notifs.filter(
      (n) => n.reason === "like" || n.reason === "repost" || n.reason === "follow",
    );

    const subjectUris = [
      ...new Set(reacts.map((n) => n.reasonSubject).filter((u): u is string => !!u)),
    ].slice(0, 25);
    const subjects = new Map<string, { text: string; url: string }>();
    if (subjectUris.length > 0) {
      const qs = subjectUris.map((u) => `uris[]=${encodeURIComponent(u)}`).join("&");
      const r = await this.request("GET", `/xrpc/app.bsky.feed.getPosts?${qs}`);
      if (r.ok) {
        const pd = await r.json();
        for (const p of pd.posts || []) {
          const rkey = p.uri.split("/").pop();
          subjects.set(p.uri, {
            text: p.record?.text || "",
            url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
          });
        }
      }
    }

    return reacts.map((n) => {
      const subj = n.reasonSubject ? subjects.get(n.reasonSubject) : undefined;
      return {
        platform: "bluesky" as const,
        reactionType: n.reason as "like" | "repost" | "follow",
        subjectId: n.reasonSubject ?? null,
        subjectExcerpt: subj?.text ?? null,
        subjectUrl: subj?.url ?? null,
        reactor: {
          handle: n.author.handle,
          did: n.author.did,
          displayName: n.author.displayName || n.author.handle,
          avatarUrl: n.author.avatar || "",
          platformIdentityId: null,
          personId: null,
        },
        reactedAt: n.indexedAt,
      };
    });
  }
}
