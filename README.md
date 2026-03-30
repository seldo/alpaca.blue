# alpaca.blue

A unified Bluesky + Mastodon client. Merges your timelines into a single chronological feed, matches cross-platform identities, and lets you reply, repost, and like from either platform.

## Tech Stack

- **Framework:** Next.js (App Router, TypeScript)
- **Database:** MariaDB, via Drizzle ORM (mysql2 driver)
- **Auth:** Bluesky OAuth (DPoP-bound via @atproto/oauth-client-browser), iron-session cookies
- **Styling:** Plain CSS, light theme

## Prerequisites

- Node.js 18+
- A MariaDB or MySQL database
- A Bluesky account (used for OAuth login)
- Optionally: an Anthropic API key (for cross-platform identity matching)

## Environment Variables

Create a `.env.local` file in the project root:

```bash
# Database (MariaDB/MySQL)
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=your_db_user
DATABASE_PASSWORD=your_db_password
DATABASE_NAME=alpaca_blue

# Session encryption — generate with: openssl rand -base64 32
SESSION_SECRET=your-32-char-or-longer-secret-here

# Anthropic API key (optional — only needed for identity resolution)
ANTHROPIC_API_KEY=sk-ant-...
```

## Database Setup

alpaca.blue uses MariaDB (MySQL-compatible). Create the database and tables with the SQL below.

> **Note:** drizzle-kit's `push` command has a bug with MariaDB 11.x and cannot be used to apply the schema. Apply it manually using the SQL below or the `mysql` CLI.

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
  INDEX person_id_idx (person_id)
);

CREATE TABLE posts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_type VARCHAR(20) NOT NULL DEFAULT 'timeline',
  platform_identity_id INT NOT NULL REFERENCES platform_identities(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  platform_post_id VARCHAR(255) NOT NULL,
  platform_post_cid VARCHAR(255),
  post_url TEXT,
  content TEXT,
  content_html TEXT,
  media LONGTEXT,
  reply_to_id VARCHAR(255),
  repost_of_id VARCHAR(255),
  quoted_post LONGTEXT,
  like_count INT DEFAULT 0,
  repost_count INT DEFAULT 0,
  reply_count INT DEFAULT 0,
  posted_at TIMESTAMP NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  dedupe_hash VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE INDEX platform_post_user_type_idx (user_id, platform, platform_post_id, post_type),
  INDEX identity_posted_idx (platform_identity_id, posted_at),
  INDEX dedupe_hash_idx (dedupe_hash),
  INDEX posted_at_idx (posted_at)
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

**Production:** The app serves its own client metadata at `/api/client-metadata`. The OAuth client ID is `https://your-domain.com/api/client-metadata`. No extra setup needed as long as the app is publicly accessible.

**Local development:** Bluesky OAuth requires a publicly reachable client metadata URL, which rules out `localhost`. Instead, the app uses [CIMD](https://cimd-service.fly.dev) (Client ID Metadata Document service) — a hosted service that registers a client ID on your behalf for local development. When running on `127.0.0.1`, the app automatically registers with CIMD and caches the resulting client ID in `localStorage`.

> **Note:** RFC 8252 requires loopback IP (`127.0.0.1`) rather than `localhost`. The app redirects automatically if you open `localhost:3000`.

## Running Locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deployment

The app is designed to run on [Netlify](https://netlify.com). Any platform that supports Next.js should work. The database needs to be reachable from the deployment environment — the app uses individual `DATABASE_*` env vars rather than a connection URL, with SSL enabled.

## Contributing

Bug reports and pull requests are welcome at [github.com/seldo/alpaca.blue](https://github.com/seldo/alpaca.blue).
