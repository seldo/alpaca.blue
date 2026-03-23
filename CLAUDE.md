# alpaca.blue

Unified social reader that merges Bluesky and Mastodon into a single chronological timeline with cross-platform identity resolution.

## Tech Stack

- **Framework:** Next.js (App Router, TypeScript)
- **Database:** MariaDB 11.8 on AWS RDS, via Drizzle ORM (mysql2 driver)
- **Auth:** Bluesky OAuth (browser-side, DPoP-bound via @atproto/oauth-client-browser), Mastodon OAuth (server-side, per-instance app registration)
- **Identity Resolution:** Heuristic pre-filtering + Claude LLM (Anthropic API)
- **Styling:** Plain CSS (no Tailwind), light theme, Work Sans font, alpaca.blue brand colors
- **Hosting:** Netlify (planned)

## Project Structure

```
src/
  app/
    page.tsx                          # Home: account connection UI
    timeline/page.tsx                 # Unified timeline feed
    identities/page.tsx               # Identity resolution management
    persons/[id]/page.tsx             # Person view (all posts across platforms)
    globals.css                       # All styles
    api/
      auth/bluesky/route.ts           # Save Bluesky handle+DID after browser OAuth
      auth/mastodon/route.ts          # Start Mastodon OAuth
      auth/mastodon/callback/route.ts # Complete Mastodon OAuth
      client-metadata/route.ts        # AT Protocol OAuth client metadata
      accounts/route.ts               # List connected accounts
      graph/
        import/route.ts               # Import follows from either platform
        identities/
          route.ts                    # GET persons + linked identities
          resolve/route.ts            # POST trigger resolution pipeline
          suggestions/route.ts        # GET/POST pending match suggestions
          link/route.ts               # POST manual identity link
          unlink/route.ts             # POST unlink identity from person
      posts/fetch/route.ts            # POST store posts from either platform
      timeline/route.ts               # GET merged deduplicated timeline
      persons/[id]/posts/route.ts     # GET posts for a specific person
  components/
    BlueskyConnect.tsx                # Bluesky OAuth connect form
    MastodonConnect.tsx               # Mastodon instance URL form
    ConnectedAccount.tsx              # Account row with import/reconnect
    PostCard.tsx                      # Timeline post card
    PersonCard.tsx                    # Person card with linked identities
    SuggestionCard.tsx                # Identity match suggestion card
  lib/
    bluesky-oauth.ts                  # Bluesky OAuth client + agent caching
    bluesky.ts                        # Server-side Bluesky follow storage
    mastodon.ts                       # Mastodon OAuth + follow import
    identity-resolution.ts            # Heuristic + LLM identity matching
    posts.ts                          # Post storage, dedup hashing, fetching
  db/
    schema.ts                         # Drizzle schema (persons, platformIdentities, posts, connectedAccounts, matchSuggestions)
    index.ts                          # DB connection (mysql2 pool with SSL)
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

### Phase 4: Polish & Deploy — TODO
- Error handling and empty states
- Performance tuning (pagination, caching)
- Deploy to Netlify with alpaca.blue domain
- UX refinements based on real usage

## Database Notes

- drizzle-kit push has a bug with MariaDB 11.8 (`Cannot read properties of undefined`). Schema changes must be applied via direct SQL using mysql2.
- Connection uses individual env vars (DATABASE_HOST, DATABASE_PORT, etc.), not a connection URL.
- SSL enabled with `rejectUnauthorized: false` for RDS.

## Environment Variables (.env.local)

- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` — MariaDB on RDS
- `ANTHROPIC_API_KEY` — for identity resolution LLM calls

## Dev Preferences

- No Tailwind — use real CSS
- Light theme
- LLM for identity resolution, not just heuristics
- Bluesky OAuth (not app passwords) — see zeitgeist project for prior art
