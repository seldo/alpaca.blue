import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  int,
  float,
  boolean,
  json,
  uniqueIndex,
  index,
} from "drizzle-orm/mysql-core";

// Unified person identity — one per real human
export const persons = mysqlTable("persons", {
  id: int("id").primaryKey().autoincrement(),
  displayName: varchar("display_name", { length: 255 }),
  notes: text("notes"), // user's private notes about this person
  autoMatched: boolean("auto_matched").default(false),
  matchConfidence: float("match_confidence"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// One per platform account — linked to a Person
export const platformIdentities = mysqlTable(
  "platform_identities",
  {
    id: int("id").primaryKey().autoincrement(),
    personId: int("person_id").references(() => persons.id, {
      onDelete: "cascade",
    }),
    platform: varchar("platform", { length: 50 }).notNull(), // 'bluesky' | 'mastodon'
    handle: varchar("handle", { length: 255 }).notNull(), // e.g. 'seldo.com' or '@seldo@mastodon.social'
    did: varchar("did", { length: 255 }), // Bluesky DID or Mastodon account URL
    displayName: varchar("display_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    profileUrl: text("profile_url"),
    verifiedDomain: varchar("verified_domain", { length: 255 }),
    isFollowed: boolean("is_followed").default(false).notNull(), // whether the user follows this account
    rawProfile: json("raw_profile"), // full API response for future use
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("platform_handle_idx").on(table.platform, table.handle),
    index("person_id_idx").on(table.personId),
  ]
);

// Cached posts from any platform
export const posts = mysqlTable(
  "posts",
  {
    id: int("id").primaryKey().autoincrement(),
    platformIdentityId: int("platform_identity_id")
      .references(() => platformIdentities.id, { onDelete: "cascade" })
      .notNull(),
    platform: varchar("platform", { length: 50 }).notNull(),
    platformPostId: varchar("platform_post_id", { length: 255 }).notNull(), // ID on the originating platform
    postUrl: text("post_url"), // canonical URL to the post on its home platform
    content: text("content"),
    contentHtml: text("content_html"), // rendered HTML (Mastodon provides this)
    media: json("media"), // array of { type, url, alt } objects
    replyToId: varchar("reply_to_id", { length: 255 }), // platform post ID of parent
    repostOfId: varchar("repost_of_id", { length: 255 }), // if this is a repost/boost
    quotedPost: json("quoted_post"), // embedded/quoted post data { uri, authorHandle, authorDisplayName, authorAvatar, text, media, postedAt }
    likeCount: int("like_count").default(0),
    repostCount: int("repost_count").default(0),
    replyCount: int("reply_count").default(0),
    postedAt: timestamp("posted_at").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    dedupeHash: varchar("dedupe_hash", { length: 64 }), // for cross-post deduplication
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("platform_post_idx").on(table.platform, table.platformPostId),
    index("identity_posted_idx").on(
      table.platformIdentityId,
      table.postedAt
    ),
    index("dedupe_hash_idx").on(table.dedupeHash),
    index("posted_at_idx").on(table.postedAt),
  ]
);

// Candidate matches between platform identities, staged for review
export const matchSuggestions = mysqlTable(
  "match_suggestions",
  {
    id: int("id").primaryKey().autoincrement(),
    blueskyIdentityId: int("bluesky_identity_id")
      .references(() => platformIdentities.id, { onDelete: "cascade" })
      .notNull(),
    mastodonIdentityId: int("mastodon_identity_id")
      .references(() => platformIdentities.id, { onDelete: "cascade" })
      .notNull(),
    heuristicScore: float("heuristic_score").notNull(),
    llmConfidence: float("llm_confidence"),
    llmReasoning: text("llm_reasoning"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    // "pending" | "confirmed" | "rejected" | "auto_confirmed"
    personId: int("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("suggestion_pair_idx").on(
      table.blueskyIdentityId,
      table.mastodonIdentityId
    ),
    index("suggestion_status_idx").on(table.status),
  ]
);

// Connected accounts — the user's own platform credentials
export const connectedAccounts = mysqlTable(
  "connected_accounts",
  {
    id: int("id").primaryKey().autoincrement(),
    platform: varchar("platform", { length: 50 }).notNull(),
    handle: varchar("handle", { length: 255 }).notNull(),
    did: varchar("did", { length: 255 }), // Bluesky DID
    instanceUrl: varchar("instance_url", { length: 255 }), // Mastodon instance
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at"),
    lastSyncAt: timestamp("last_sync_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [uniqueIndex("connected_platform_idx").on(table.platform, table.handle)]
);
