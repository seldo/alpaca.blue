# alpaca.blue

Unified social reader that merges Bluesky and Mastodon into a single chronological timeline with cross-platform identity resolution. Multi-user, with Bluesky OAuth login.

## Tech Stack

- **Framework:** Next.js (App Router, TypeScript)
- **Database:** MariaDB 11.8 on AWS RDS, via Drizzle ORM (mysql2 driver)
- **Auth:** Bluesky OAuth login (browser-side, DPoP-bound via @atproto/oauth-client-browser), iron-session for encrypted cookie sessions
- **Mastodon:** OAuth (server-side, per-instance app registration) for connecting Mastodon accounts after login
- **Identity Resolution:** Heuristic pre-filtering + Claude LLM (Anthropic API)
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
    identities/page.tsx                # Identity resolution management
    persons/[id]/page.tsx              # Person view (all posts across platforms)
    posts/[id]/page.tsx                # Individual post detail page
    globals.css                        # All styles
    api/
      auth/bluesky/route.ts           # Complete Bluesky OAuth — create/find user, set session
      auth/mastodon/route.ts           # Start Mastodon OAuth (accepts handles like @user@instance)
      auth/mastodon/callback/route.ts  # Complete Mastodon OAuth
      auth/me/route.ts                 # GET current user info (avatar, handle, display name)
      auth/logout/route.ts             # POST clear session
      client-metadata/route.ts         # AT Protocol OAuth client metadata
      accounts/route.ts                # List connected accounts for current user
      graph/
        import/route.ts               # Import follows from either platform
        identities/
          route.ts                     # GET persons + linked identities
          resolve/route.ts             # POST trigger resolution pipeline
          suggestions/route.ts         # GET/POST pending match suggestions
          link/route.ts                # POST manual identity link
          unlink/route.ts              # POST unlink identity from person
      posts/
        fetch/route.ts                 # POST store posts (supports type: "mentions")
        lookup/route.ts                # POST find/create post by platform URI
        [id]/route.ts                  # GET single post with cross-post lookup
      timeline/route.ts               # GET merged deduplicated timeline (supports ?type=mentions)
      persons/[id]/posts/route.ts     # GET posts for a specific person
  components/
    AppHeader.tsx                      # App layout: sidebar nav + mobile bottom bar
    BlueskyConnect.tsx                 # Bluesky OAuth connect form (unused — login handles this)
    MastodonConnect.tsx                # Mastodon instance URL / handle form
    ConnectedAccount.tsx               # Account row with import/reconnect buttons
    PostCard.tsx                       # Post card with images, quotes, links, image modal
    PersonCard.tsx                     # Person card with linked identities
    SuggestionCard.tsx                 # Identity match suggestion card
  lib/
    bluesky-oauth.ts                   # Bluesky OAuth client + agent caching + session cleanup
    bluesky.ts                         # Server-side Bluesky follow storage
    mastodon.ts                        # Mastodon OAuth + follow import + mentions fetch
    identity-resolution.ts             # Heuristic + LLM identity matching
    posts.ts                           # Post storage, dedup hashing, Mastodon mentions
    session.ts                         # iron-session config (SessionData, getSession, requireSession)
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

## Build Phases

### Phase 1: Foundation — COMPLETE
- Project scaffold, Bluesky + Mastodon OAuth, account connection UI
- Follow import from both platforms into platformIdentities table

### Phase 2: Identity Resolution — COMPLETE
- matchSuggestions table for tracking match candidates
- Resolution engine: heuristic scoring (bio cross-links, handle similarity, display name, verified domains) → LLM batch evaluation (Claude API) → auto-confirm ≥0.9, pending 0.5–0.9, rejected <0.5
- API routes for triggering resolution, reviewing suggestions, manual link/unlink
- Identity management UI page with suggestion cards

### Phase 3: Unified Timeline — COMPLETE
- Post fetching from both platforms (Bluesky client-side via Agent, Mastodon server-side)
- Cross-post deduplication via content hash (normalize text, strip URLs, 5-minute time window, SHA-256)
- Timeline API with cursor pagination, joined with identity/person data
- Timeline page with PostCard component (author info, platform badges, media, engagement counts)
- Person view page showing all posts from a linked person across platforms

### Phase 4: Polish & UX — COMPLETE
- Multi-user support with Bluesky OAuth login and iron-session cookies
- `users` table with per-user data isolation across all tables
- Auth middleware redirecting unauthenticated users to /login
- Mentions feed: merged Bluesky notifications + Mastodon mentions
- Individual post detail page with cross-post display
- Sidebar navigation (desktop) + bottom bar (mobile, <640px breakpoint)
- Image modal with multi-image navigation (arrows + keyboard)
- Quoted post display and click-through
- Rich text: Bluesky facets, linkified URLs, Mastodon HTML sanitization
- Timeline state preservation via sessionStorage + scroll restoration
- Onboarding flow with step-by-step account connection
- PWA manifest and app icons

### Phase 5: Deploy — COMPLETE
- Deployed to Netlify at alpaca.blue
- Performance tuning (pagination, caching) — ongoing

## Database Notes

- drizzle-kit push has a bug with MariaDB 11.8 (`Cannot read properties of undefined`). Schema changes must be applied via direct SQL using mysql2.
- Connection uses individual env vars (DATABASE_HOST, DATABASE_PORT, etc.), not a connection URL.
- SSL enabled with `rejectUnauthorized: false` for RDS.
- JSON columns (e.g. `quotedPost`) are stored as `longtext` — require manual `JSON.parse()` when reading.
- All tables have a `userId` foreign key for multi-user isolation.

## Environment Variables (.env.local)

- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` — MariaDB on RDS
- `ANTHROPIC_API_KEY` — for identity resolution LLM calls
- `SESSION_SECRET` — 32+ char secret for iron-session cookie encryption

## Dev Preferences

- No Tailwind — use real CSS
- Light theme
- LLM for identity resolution, not just heuristics
- Bluesky OAuth for login (not app passwords)
- Responsive layout: sidebar on desktop, bottom bar on mobile
