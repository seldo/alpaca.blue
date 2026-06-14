# alpaca.blue

## IMPORTANT: Git Rules
**NEVER commit or push without explicit instruction from the user.** Always wait to be asked before running any git commit or git push commands.

Unified social reader that merges Bluesky and Mastodon into a single chronological timeline with cross-platform identity resolution. Multi-user, with Bluesky OAuth login.

## Architecture (read this first)

**All post fetching, dedup/merge, realtime, and writes happen in the browser**, talking
directly to Bluesky (the user's PDS over CORS-enabled XRPC) and Mastodon. The server is
deliberately minimal: auth/session, identity matching + the identity-map download,
alt-text + link-card metadata (the CORS-bound bits), and credential brokering. There is
**no** server-side post cache, timeline route, heartbeat, or streaming worker anymore —
those were removed in the client-fetching refactor. When something looks server-shaped
(a fetch loop, a posts table), assume it's been moved client-side and check `src/lib/client/`.

## Tech Stack

- **Framework:** Next.js (App Router, TypeScript)
- **Database:** MariaDB 11.8 on AWS RDS, via Drizzle ORM (mysql2 driver) — identities/persons/matching only; no post cache
- **Auth:** Bluesky OAuth login is server-side (`@atproto/oauth-client-node`, DPoP keys in Redis); iron-session cookie. After login the browser fetches Bluesky directly using **brokered credentials** (see Bluesky OAuth Notes).
- **Mastodon:** OAuth (server-side app registration) to connect; afterward the browser calls the instance directly with the bearer token.
- **Identity Resolution:** Heuristic pre-filtering + Claude LLM (Anthropic API)
- **Client data layer:** `src/lib/client/` — direct platform fetch, WebCrypto DPoP signing (secp256k1 via `@noble/curves`), dedup/merge, IndexedDB store, WSS+poll realtime.
- **Cache:** Upstash Redis (serverless REST via `@upstash/redis`) — now **only** Bluesky OAuth state/session + an identity profile-refresh debounce.
- **Styling:** Plain CSS (no Tailwind), light theme, Work Sans font, alpaca.blue brand colors
- **PWA:** manifest.json with app icons for home screen installation
- **Hosting:** Netlify at alpaca.blue

## Project Structure

```
src/
  middleware.ts                        # Auth middleware — redirects to /login if no session
  app/
    layout.tsx                         # Root layout with PWA meta tags
    page.tsx                           # Home: onboarding + account connection UI
    login/page.tsx                     # Bluesky OAuth login page
    timeline/page.tsx                  # Unified timeline feed
    mentions/page.tsx                  # Mentions feed (replies + @-mentions)
    profile/page.tsx                   # Own posts feed (deduplicated cross-posts)
    identities/page.tsx                # Identity resolution management
    persons/[id]/page.tsx              # Person view (all posts across platforms)
    posts/[id]/page.tsx                # Individual post detail page
    globals.css                        # All styles
    api/
      auth/bluesky/authorize/route.ts  # POST {handle} → returns {url} for OAuth redirect
      auth/bluesky/callback/route.ts   # GET ?code=&state= → completes OAuth, sets iron-session
      auth/mastodon/route.ts           # Start Mastodon OAuth (accepts handles like @user@instance)
      auth/mastodon/callback/route.ts  # Complete Mastodon OAuth
      auth/me/route.ts                 # GET current user info (avatar, handle, display name, blueskyDid)
      auth/logout/route.ts             # POST clear session
      client-metadata/route.ts         # AT Protocol OAuth client metadata (redirect_uri: /api/auth/bluesky/callback)
      accounts/route.ts                # List connected accounts (profile metadata for the header)
      accounts/credentials/route.ts    # GET → hand the browser its Mastodon {instanceUrl, accessToken}
      accounts/disconnect/route.ts     # POST {platform} → disconnect mastodon / wipe all
      ai/describe-image/route.ts       # POST FormData{file} → Claude Haiku vision alt text
      bluesky/
        credentials/route.ts           # GET → brokered {did, pdsUrl, accessToken, dpopPrivateJwk} for direct PDS calls
        credentials/refresh/route.ts   # POST → server-side (locked) token refresh → fresh accessToken
        link-card/route.ts             # GET ?url= → OG metadata + thumb bytes (CORS-bound fetch the browser can't do)
      mastodon/
        route.ts + callback/route.ts   # Mastodon OAuth connect
      graph/
        import/route.ts                # Import follows from either platform (feeds matching; uses server Bluesky agent)
        identities/
          route.ts                     # GET persons + linked identities — the identity-map download the client caches
          resolve/route.ts             # POST trigger resolution pipeline
          suggestions/route.ts         # GET/POST pending match suggestions
          link/route.ts                # POST manual identity link
          unlink/route.ts              # POST unlink identity from person
      identities/[id]/refresh/route.ts # POST → re-fetch an identity's avatar/profile (Avatar fallback; server agent)
  components/
    AppHeader.tsx                      # App layout: sidebar nav + mobile bottom bar + global compose modal
    PostCard.tsx                       # Post card; reactions/quote nav via ClientActionsContext
    CreatePost.tsx                     # Compose UI (always client): text + images (ALT), cross-posts to both platforms
    Avatar.tsx                         # Avatar with broken-URL refresh via /api/identities/[id]/refresh
    PersonCard.tsx / SuggestionCard.tsx / MastodonConnect.tsx / ConnectedAccount.tsx
  lib/
    client/                            # ── THE CLIENT DATA LAYER (most fetching lives here) ──
      bluesky.ts                       #   BlueskyClient: WebCrypto DPoP fetch to the PDS; timeline/mentions/author/
                                       #   profile/thread/reactions; like/repost/post/uploadBlob/follow
      mastodon.ts                      #   Direct token-auth fetch: timelines, mentions, statuses, reactions, thread,
                                       #   favourite/reblog/post/media/follow, credentials
      transform.ts / transform-bluesky.ts  # Pure mappers (status/feed-item → ClientPost), facets→HTML
      dedup.ts                         #   WebCrypto dedup hash + cross-post merge (+ attachDedupeHashes)
      store.ts                         #   IndexedDB per-feed store (timeline/mentions/profile)
      realtime.ts                      #   Mastodon WSS user stream + Bluesky polling
      identities.ts                    #   Cached person/identity map; enrichAuthor/enrichReactor; fetchPostsForIdentity
      actions.ts + ClientActionsContext.ts  # like/repost (+ cross-platform fanout); context PostCard reads
      useClientTimeline.ts / useClientFeed.ts  # Feed hooks: fetch → store → merge → "N new" pill
      types.ts                         #   ClientPost shape (PostCard-compatible)
    bluesky-server.ts                  # NodeOAuthClient (server), Redis state/session, getServerBlueskyAgent(), getBrokeredBlueskyCredentials()
    bluesky.ts                         # Server-side Bluesky follow storage (matching import)
    mastodon.ts                        # Mastodon OAuth + follow import
    identity-resolution.ts             # Heuristic + LLM identity matching
    link-preview.ts                    # OG metadata + thumb-bytes fetch for /api/bluesky/link-card
    redis.ts                           # Upstash Redis client + KEY_PREFIX
    session.ts                         # iron-session config
    usePullToRefresh.ts                # Hook: pull-to-refresh
  db/
    schema.ts                          # Drizzle schema (users, connectedAccounts, platformIdentities, persons, matchSuggestions)
    index.ts                           # DB connection (mysql2 pool with SSL)
public/
  manifest.json                        # PWA manifest
  logomark.svg                         # App icon (alpaca head)
  logo-horizontal.svg                  # Full logo with wordmark
  logotype.svg                         # Wordmark only
  icon-192.png, icon-512.png           # PWA icons
  apple-touch-icon.png                 # iOS home screen icon
  favicon-16.png, favicon-32.png       # Favicons
```

## How It Works

- **Authentication:** Bluesky OAuth is the login mechanism (server-side). Users connect an optional Mastodon account after login. All accounts are isolated per-user via `userId` foreign keys.
- **Post fetching (client):** Feed hooks (`useClientTimeline`, `useClientFeed`) fetch from both platforms in the browser → map to `ClientPost` → dedup/merge → store in IndexedDB → render. Cold loads paint instantly from IndexedDB, then refresh. No server fetch, no DB cache.
- **Deduplication (client):** `dedup.ts` — SHA-256 of normalized text via WebCrypto (bit-identical to the old Node hash). Cross-posts collapse into one entry with `alsoPostedOn`; short posts only merge within the same resolved person.
- **Realtime (client):** Mastodon over its WSS `user` stream; Bluesky by polling `getTimeline`/`listNotifications` (~25–30s). New arrivals are stashed behind an "N new posts" pill. (Matches what each platform's own web client does.)
- **Mentions:** Bluesky notifications (mention/reply/quote, hydrated via `getPosts`) + Mastodon mentions, **plus** reaction notifications (likes/reposts/follows via `groupReactions`) interleaved by time.
- **Reactions/writes (client):** like/repost go through `ClientActionsContext` → `actions.ts` → the platform directly, with native cross-platform fanout. PostCard has no server-route fallback.
- **Cross-posting:** New posts go to both platforms simultaneously from the browser. Images compressed client-side (JPEG quality reduction under 950KB for Bluesky's 1MB limit), ALT captured per image. After posting, a `posts:created` event nudges the active feed to refresh.
- **Bluesky rich text (client):** `RichText.detectFacets` runs in the browser (mentions resolved via `resolveHandle`); bare-link posts get a preview card whose OG metadata comes from `/api/bluesky/link-card` but whose thumb blob is uploaded with the user's own DPoP creds.
- **Thread replies:** Posts carry `threadRootId`/`threadRootCid`; replies pass them as the AT Proto `root` ref. `alsoPostedOn` carries per-platform ids/cids so a reply/repost fans out to both sides.
- **Post detail (`/posts/[id]`):** keyed by `"<platform>:<platformPostId>"` (URL-encoded); the client fetches the thread (Bluesky `getPostThread` / Mastodon `/context`). No numeric DB ids anymore.
- **Identity map:** `/api/graph/identities` is downloaded once and cached (`identities.ts`); it enriches post authors + reactors (links to `/persons/:id` or `/identities/:id`) and drives person-based cross-platform dedup.
- **Identity resolution:** Heuristic scoring → LLM batch eval (Claude) → auto-confirm ≥0.9, pending 0.5–0.9, rejected <0.5. Persons group linked identities across platforms.
- **PWA:** Installable via manifest.json.

## Bluesky OAuth Notes

- **Login** is server-side (`@atproto/oauth-client-node`): browser POSTs handle to `/api/auth/bluesky/authorize` → redirect → `/api/auth/bluesky/callback` completes OAuth, creates/finds user, sets iron-session. DPoP keys stored as JWK in Redis (`bluesky:state:{key}` 10min TTL; `bluesky:session:{did}` no TTL).
- **Data access is brokered, not server-side.** `getBrokeredBlueskyCredentials(userId)` reads the Redis session and hands the browser `{ did, pdsUrl (=tokenSet.aud), accessToken, dpopPrivateJwk }` via `/api/bluesky/credentials`. The browser signs its own DPoP proofs (`src/lib/client/bluesky.ts`) and calls the PDS directly.
  - **Bluesky issues secp256k1 (ES256K) DPoP keys** — WebCrypto can't sign those, so we use `@noble/curves`. (P-256 falls back to WebCrypto.)
  - **Refresh ownership is split:** the server owns refresh (rare, serialized by the distributed Redis lock so Bluesky's one-time refresh token can't be double-spent); the browser owns reads and calls `/api/bluesky/credentials/refresh` on a 401. The refresh token never leaves the server.
  - First PDS request per session 401s with `use_dpop_nonce` and silently retries with the nonce — that's the normal DPoP handshake, not an error.
- `getServerBlueskyAgent(userId)` still exists for the few remaining server Bluesky needs: follow import (`graph/import`) and avatar refresh (`identities/[id]/refresh`).
- `getNodeOAuthClient()` is a singleton; init failures must NOT be cached (a poisoned rejected promise blocks all later requests until restart — see the `.then(onFulfilled, onRejected)` clearing `_clientInitPromise`).
- **`APP_URL`** must be the full origin (`http://127.0.0.1:3000` dev — loopback IP, not `localhost`; `https://alpaca.blue` prod). Browse to the same origin you set, or the OAuth callback/cookie origins mismatch.
- For localhost dev, the CIMD service (cimd-service.fly.dev) registers OAuth clients dynamically; the `client_id` is cached in Redis.

## Security tradeoff (conscious)

The brokered Bluesky access token + DPoP key and the Mastodon bearer token are exposed to client JS — a larger XSS blast radius than fully-server-side, accepted in exchange for direct client fetching. Refresh tokens stay server-side.

## Redis Notes

- Uses **Upstash Redis** (REST API, `@upstash/redis`) — suitable for Netlify serverless. Client + `KEY_PREFIX` in `src/lib/redis.ts` (the old `keys`/`TTL` cache-key constants were removed with the post cache).
- Remaining uses (all built inline with `KEY_PREFIX`):
  - **Bluesky OAuth state** (`bluesky:state:{key}`, 10min TTL) and **sessions** (`bluesky:session:{did}`, no TTL) — NodeOAuthClient stores.
  - **Distributed refresh lock** — serializes Bluesky token refresh across serverless instances.
  - **Identity profile-refresh debounce** (`identity:profile_fetched:{id}`, 60s) — `identities/[id]/refresh`.
- Non-OAuth Redis calls use `.catch(() => {})` to fail silently.

## Database Notes

- drizzle-kit push has a bug with MariaDB 11.8 (`Cannot read properties of undefined`). Schema changes must be applied via direct SQL using mysql2.
- **`.env.local` points at the PRODUCTION DB** — any migration/DROP run locally hits prod. Be careful.
- The `posts` and `cross_post_mirrors` tables are **no longer in the Drizzle schema** (posts are client-side now). They still exist in the prod DB as orphans — safe to `DROP` manually, nothing reads/writes them.
- Connection uses individual env vars (DATABASE_HOST, etc.). SSL with `rejectUnauthorized: false`. JSON columns land as `longtext` (manual `JSON.parse()`). All tables have a `userId` FK.

## Environment Variables (.env.local)

- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` — MariaDB on RDS
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis (serverless)
- `ANTHROPIC_API_KEY` — for identity resolution LLM calls
- `SESSION_SECRET` — 32+ char secret for iron-session cookie encryption
- `APP_URL` — full origin URL (e.g. `http://127.0.0.1:3000` dev, `https://alpaca.blue` prod) — required for server-side Bluesky OAuth redirect URI
- `REDIS_KEY_PREFIX` — prefix for all Redis keys (e.g. `dev:`) to isolate dev and prod on a shared instance

## Dev Preferences

- No Tailwind — use real CSS
- Light theme
- LLM for identity resolution, not just heuristics
- Bluesky OAuth for login (not app passwords)
- Responsive layout: sidebar on desktop, bottom bar on mobile
