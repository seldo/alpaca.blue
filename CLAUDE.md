# alpaca.blue

## IMPORTANT: Git Rules
**NEVER commit or push without explicit instruction from the user.** Always wait to be asked before running any git commit or git push commands.

Unified social reader that merges Bluesky and Mastodon into a single chronological timeline with cross-platform identity resolution. Multi-user, with Bluesky OAuth login.

## Tech Stack

- **Framework:** Next.js (App Router, TypeScript)
- **Database:** MariaDB 11.8 on AWS RDS, via Drizzle ORM (mysql2 driver)
- **Auth:** Bluesky OAuth login (fully server-side, DPoP keys stored in Redis via @atproto/oauth-client-node), iron-session for encrypted cookie sessions
- **Mastodon:** OAuth (server-side, per-instance app registration) for connecting Mastodon accounts after login
- **Identity Resolution:** Heuristic pre-filtering + Claude LLM (Anthropic API)
- **Cache:** Upstash Redis (serverless REST API via `@upstash/redis`) — debouncing, timeline caching, reactions caching
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
      accounts/route.ts                # List connected accounts for current user
      bluesky/
        like/route.ts                  # POST {uri, cid} → agent.like()
        repost/route.ts                # POST {uri, cid} → agent.repost()
        post/route.ts                  # POST {text, replyTo?, replyRoot?, quote?, images?} → RichText.detectFacets → agent.post()
        upload-blob/route.ts           # POST FormData{file} → agent.uploadBlob() → {blob}
        author-feed/route.ts           # GET ?cursor= → agent.getAuthorFeed()
      mastodon/
        reply/route.ts                 # POST {statusId, content} → reply to Mastodon status by ID
      graph/
        import/route.ts               # Import follows from either platform (server-side for both)
        identities/
          route.ts                     # GET persons + linked identities
          resolve/route.ts             # POST trigger resolution pipeline
          suggestions/route.ts         # GET/POST pending match suggestions
          link/route.ts                # POST manual identity link
          unlink/route.ts              # POST unlink identity from person
      posts/
        heartbeat/route.ts             # POST — triggered every 7s by client; fetches all platforms if debounce expired
        fetch/route.ts                 # POST — legacy full fetch+return (still used by manual refresh paths)
        create/route.ts                # POST {content, mediaIds?} → post to Mastodon
        upload-media/route.ts          # POST FormData{file} → Mastodon /api/v1/media → {id}
        lookup/route.ts                # POST find/create post by platform URI
        [id]/route.ts                  # GET single post with cross-post lookup
      reactions/
        fetch/route.ts                 # POST — fetches reactions from both platforms server-side (cached 60s)
      timeline/route.ts               # GET merged deduplicated timeline (supports ?type=mentions); reads from Redis/DB only
      persons/[id]/posts/route.ts     # GET posts for a specific person
      profile/posts/route.ts          # POST fetch+store own posts from all platforms; GET cursor pagination
  components/
    AppHeader.tsx                      # App layout: sidebar nav + mobile bottom bar
    BlueskyConnect.tsx                 # Bluesky OAuth connect form (unused — login handles this)
    MastodonConnect.tsx                # Mastodon instance URL / handle form
    ConnectedAccount.tsx               # Account row with import/reconnect buttons
    PostCard.tsx                       # Post card with images, quotes, links, image modal, reply/repost/like
    CreatePost.tsx                     # Compose UI: text + images (with ALT text), cross-posts to both platforms
    PersonCard.tsx                     # Person card with linked identities
    SuggestionCard.tsx                 # Identity match suggestion card
  lib/
    bluesky-server.ts                  # NodeOAuthClient (server-side), Redis state/session stores, getServerBlueskyAgent()
    bluesky.ts                         # Server-side Bluesky follow storage
    mastodon.ts                        # Mastodon OAuth + follow import + mentions fetch
    identity-resolution.ts             # Heuristic + LLM identity matching
    posts.ts                           # Post storage, dedup hashing, server-side Bluesky/Mastodon fetch functions
    redis.ts                           # Upstash Redis client + cache key constants + TTLs
    session.ts                         # iron-session config (SessionData, getSession, requireSession)
    usePullToRefresh.ts                # Hook: pull-to-refresh via touch drag + wheel overscroll
  db/
    schema.ts                          # Drizzle schema (users, connectedAccounts, platformIdentities, persons, posts, matchSuggestions)
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

- **Authentication:** Bluesky OAuth is the login mechanism. Users connect an optional Mastodon account after login. All accounts are isolated per-user via `userId` foreign keys.
- **Post fetching:** A client-side heartbeat fires every 7 seconds. The server fetches from Bluesky and Mastodon if the per-platform debounce (30s) has expired, stores posts in DB, and updates the Redis cache. Pull-to-refresh reads from Redis/DB only — it never hits platform APIs directly.
- **Deduplication:** Cross-posted content is deduplicated via SHA-256 hash of normalized text (stripped URLs, 5-min time window).
- **Timeline:** Merged, deduplicated, cursor-paginated feed from both platforms. First page is cached in Redis (60s TTL).
- **Mentions:** Bluesky notifications (replies, quotes, mentions) + Mastodon mentions merged into a single feed. Same heartbeat/cache model as timeline.
- **Reactions:** Likes, reposts, follows fetched server-side and cached (60s). Like/repost/reply actions POST to API routes which call the Bluesky agent server-side.
- **Cross-posting:** New posts are sent to both Bluesky and Mastodon simultaneously. Images are compressed client-side (iterative JPEG quality reduction until under 950KB for Bluesky's 1MB limit) and ALT text is captured per image. After posting, the heartbeat is force-triggered (busts all debounce and cache keys) then a full UI refresh reads the updated cache.
- **Cross-platform replies:** When replying to a post that appears on both platforms (`alsoPostedOn`), the reply is sent to both platforms simultaneously via `Promise.allSettled`. Enables cross-platform threads.
- **Thread replies:** Posts store `thread_root_id`/`thread_root_cid` (from `record.reply.root` in the Bluesky feed). Replies pass these as the AT Protocol `root` ref so nested replies thread correctly in Bluesky. The `alsoPostedOn` array also carries `platformPostId`/`platformPostCid`/`threadRootId`/`threadRootCid` for the same reason.
- **Profile feed:** The user's own posts from both platforms, deduplicated the same way as the timeline. Cross-posts collapsed into one entry with `alsoPostedOn`.
- **Identity resolution:** Heuristic scoring (bio cross-links, handle similarity, display name, verified domains) → LLM batch evaluation (Claude API) → auto-confirm ≥0.9, pending 0.5–0.9, rejected <0.5. Persons group linked identities across platforms.
- **Rich text:** When posting to Bluesky, `RichText.detectFacets(agent)` auto-detects URLs (including bare domains), @-mentions, and #hashtags and generates the `facets` array. Stored Bluesky posts have facets rendered to HTML server-side. Mastodon handles linkification server-side — plain text is sufficient.
- **State preservation:** Timeline scroll position and feed cache stored in sessionStorage for instant back-navigation.
- **PWA:** Installable as a home screen app via manifest.json. Stuck fetches are aborted on `visibilitychange` to handle iOS PWA backgrounding.

## Bluesky OAuth Notes

- All Bluesky operations are **fully server-side** using `@atproto/oauth-client-node`. There is no browser-side Bluesky agent.
- OAuth flow: browser POSTs handle to `/api/auth/bluesky/authorize` → server returns redirect URL → browser redirects → Bluesky redirects to `/api/auth/bluesky/callback` → server completes OAuth, creates/finds user, sets iron-session.
- DPoP keys are stored as serialized JWK in Redis (`bluesky:state:{key}` with 10min TTL for OAuth state, `bluesky:session:{key}` with no TTL for sessions).
- `getServerBlueskyAgent(userId)` in `bluesky-server.ts` looks up the user's `blueskyDid` from DB, then calls `client.restore(did)` to get a valid agent with automatic token refresh.
- Access tokens expire after ~2 hours. `restore()` automatically uses the refresh token (90-day sliding window). Bluesky uses one-time-use refresh tokens that rotate on each use.
- `requestLocalLock` from `@atproto/oauth-client` prevents concurrent token refresh races.
- **`APP_URL` env var** is required for server-side OAuth: must be the full origin (e.g. `http://127.0.0.1:3000` for dev, `https://alpaca.blue` for prod). Used to build the redirect URI.
- For localhost dev, the CIMD service (cimd-service.fly.dev) registers OAuth clients dynamically. The registered `client_id` is cached in Redis to avoid re-registration on every cold start.

## Redis Notes

- Uses **Upstash Redis** (REST API, `@upstash/redis`) — suitable for Netlify serverless, no TCP connection needed.
- Configured in `src/lib/redis.ts` with cache key constants and TTL constants.
- Current cache uses:
  - **Bluesky OAuth state** (`bluesky:state:{key}`, 10min TTL) — NodeOAuthClient state store
  - **Bluesky OAuth sessions** (`bluesky:session:{did}`, no TTL) — NodeOAuthClient session store (DPoP keys as JWK)
  - **Bluesky fetch debounce** (`bluesky:fetched:{userId}:{timeline|mentions}`, 30s TTL) — prevents rapid duplicate Bluesky API calls
  - **Bluesky reactions cache** (`bluesky:reactions:{userId}`, 60s TTL)
  - **Mastodon fetch debounce** (`mastodon:fetched:{userId}:{timeline|mentions}`, 30s TTL) — prevents rapid duplicate Mastodon API calls
  - **Timeline/mentions first-page cache** (`timeline:cache:{userId}:{timeline|mentions}`, 60s TTL) — caches first page (no cursor) of results including `nextCursor`
  - **Mastodon reactions cache** (`mastodon:reactions:{userId}`, 60s TTL)
- Cache is invalidated (`redis.del`) when new posts are stored.
- All non-OAuth Redis calls use `.catch(() => {})` to fail silently — Redis is non-critical for post data.

## Database Notes

- drizzle-kit push has a bug with MariaDB 11.8 (`Cannot read properties of undefined`). Schema changes must be applied via direct SQL using mysql2.
- Connection uses individual env vars (DATABASE_HOST, DATABASE_PORT, etc.), not a connection URL.
- SSL enabled with `rejectUnauthorized: false` for RDS.
- JSON columns (e.g. `quotedPost`) are stored as `longtext` — require manual `JSON.parse()` when reading.
- All tables have a `userId` foreign key for multi-user isolation.

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
