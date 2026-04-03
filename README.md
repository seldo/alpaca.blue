# alpaca.blue

A unified Bluesky + Mastodon client. Merges your timelines into a single chronological feed, matches cross-platform identities, and lets you post, reply, repost, and like from either platform.

## Tech Stack

- **Framework:** Next.js (App Router, TypeScript)
- **Database:** MariaDB, via Drizzle ORM (mysql2 driver)
- **Auth:** Bluesky OAuth — fully server-side via `@atproto/oauth-client-node`, DPoP keys stored in Redis; iron-session encrypted cookies
- **Cache:** Upstash Redis (serverless REST) — OAuth sessions, fetch debounce, timeline cache, reactions cache
- **Styling:** Plain CSS, light theme, Work Sans font

## Prerequisites

- Node.js 18+
- A MariaDB or MySQL database
- An Upstash Redis instance (free tier works fine)
- A Bluesky account (used for OAuth login)
- Optionally: a Mastodon account and an Anthropic API key (for cross-platform identity matching)

## Environment Variables

Create a `.env.local` file in the project root:

```bash
# Database (MariaDB/MySQL)
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=your_db_user
DATABASE_PASSWORD=your_db_password
DATABASE_NAME=alpaca_blue

# Upstash Redis
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token

# Session encryption — generate with: openssl rand -base64 32
SESSION_SECRET=your-32-char-or-longer-secret-here

# Full origin URL — used for Bluesky OAuth redirect URI
# Use http://127.0.0.1:3000 for local dev, https://your-domain.com for prod
APP_URL=http://127.0.0.1:3000

# Redis key prefix — prevents dev/prod collision on a shared Redis instance
REDIS_KEY_PREFIX=dev:

# Anthropic API key (optional — only needed for identity resolution)
ANTHROPIC_API_KEY=sk-ant-...
```

## Database Setup

alpaca.blue uses MariaDB (MySQL-compatible). Create the database and apply the schema below.

> **Note:** `drizzle-kit push` has a bug with MariaDB 11.x and cannot be used. Apply the schema manually via the `mysql` CLI or any SQL client.

### Create the database

```sql
CREATE DATABASE alpaca_blue CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### Create the tables

```sql
USE alpaca_blue;

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  bluesky_did VARCHAR(255) NOT NULL,
  bluesky_handle VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  UNIQUE INDEX bluesky_did_idx (bluesky_did)
);

CREATE TABLE persons (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(255),
  notes TEXT,
  auto_matched BOOLEAN DEFAULT FALSE,
  match_confidence FLOAT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW()
);

CREATE TABLE platform_identities (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INT REFERENCES persons(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  handle VARCHAR(255) NOT NULL,
  did VARCHAR(255),
  display_name VARCHAR(255),
  avatar_url TEXT,
  bio TEXT,
  profile_url TEXT,
  verified_domain VARCHAR(255),
  is_followed BOOLEAN NOT NULL DEFAULT FALSE,
  raw_profile JSON,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  UNIQUE INDEX platform_handle_user_idx (user_id, platform, handle),
  INDEX person_id_idx (person_id),
  INDEX platform_did_user_idx (user_id, platform, did)
);

CREATE TABLE posts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_timeline BOOLEAN NOT NULL DEFAULT FALSE,
  is_mention BOOLEAN NOT NULL DEFAULT FALSE,
  platform_identity_id INT NOT NULL REFERENCES platform_identities(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  platform_post_id VARCHAR(255) NOT NULL,
  platform_post_cid VARCHAR(255),
  post_url TEXT,
  content TEXT,
  content_html TEXT,
  media LONGTEXT,
  reply_to_id VARCHAR(255),
  thread_root_id VARCHAR(255),
  thread_root_cid VARCHAR(255),
  repost_of_id VARCHAR(255),
  quoted_post LONGTEXT,
  link_card TEXT,
  like_count INT DEFAULT 0,
  repost_count INT DEFAULT 0,
  reply_count INT DEFAULT 0,
  posted_at TIMESTAMP NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  dedupe_hash VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE INDEX platform_post_user_idx (user_id, platform, platform_post_id),
  INDEX identity_posted_idx (platform_identity_id, posted_at),
  INDEX dedupe_hash_idx (dedupe_hash),
  INDEX posted_at_idx (posted_at),
  INDEX user_timeline_posted_idx (user_id, is_timeline, posted_at),
  INDEX user_mention_posted_idx (user_id, is_mention, posted_at)
);

CREATE TABLE match_suggestions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bluesky_identity_id INT NOT NULL REFERENCES platform_identities(id) ON DELETE CASCADE,
  mastodon_identity_id INT NOT NULL REFERENCES platform_identities(id) ON DELETE CASCADE,
  heuristic_score FLOAT NOT NULL,
  llm_confidence FLOAT,
  llm_reasoning TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  person_id INT REFERENCES persons(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  UNIQUE INDEX suggestion_pair_user_idx (user_id, bluesky_identity_id, mastodon_identity_id),
  INDEX suggestion_status_idx (status)
);

CREATE TABLE connected_accounts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  handle VARCHAR(255) NOT NULL,
  did VARCHAR(255),
  instance_url VARCHAR(255),
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  last_sync_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  UNIQUE INDEX connected_platform_user_idx (user_id, platform, handle)
);
```

## Bluesky OAuth Setup

**Production:** The app serves its own client metadata at `/api/client-metadata`. No extra setup needed as long as `APP_URL` is set to your public domain.

**Local development:** Bluesky OAuth requires a publicly reachable client metadata URL. The app uses [CIMD](https://cimd-service.fly.dev) — a hosted service that registers a client ID on your behalf for local development. The resulting client ID is cached in Redis.

> **Note:** RFC 8252 requires the loopback IP `127.0.0.1` rather than `localhost`. Set `APP_URL=http://127.0.0.1:3000` and open the app at that address.

## Running Locally

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## Deployment

Designed to run on [Netlify](https://netlify.com). Any platform that supports Next.js serverless functions should work. The database and Redis instance need to be reachable from the deployment environment.

## Contributing

Bug reports and pull requests are welcome at [github.com/seldo/alpaca.blue](https://github.com/seldo/alpaca.blue).
