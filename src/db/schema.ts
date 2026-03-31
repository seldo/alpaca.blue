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

// Registered user — identified by Bluesky DID
export const users = mysqlTable(
  "users",
  {
    id: int("id").primaryKey().autoincrement(),
    blueskyDid: varchar("bluesky_did", { length: 255 }).notNull(),
    blueskyHandle: varchar("bluesky_handle", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [uniqueIndex("bluesky_did_idx").on(table.blueskyDid)]
);

// Unified person identity — one per real human
export const persons = mysqlTable("persons", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  displayName: varchar("display_name", { length: 255 }),
  notes: text("notes"),
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
    userId: int("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    personId: int("person_id").references(() => persons.id, {
      onDelete: "cascade",
    }),
    platform: varchar("platform", { length: 50 }).notNull(),
    handle: varchar("handle", { length: 255 }).notNull(),
    did: varchar("did", { length: 255 }),
    displayName: varchar("display_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    profileUrl: text("profile_url"),
    verifiedDomain: varchar("verified_domain", { length: 255 }),
    isFollowed: boolean("is_followed").default(false).notNull(),
    rawProfile: json("raw_profile"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("platform_handle_user_idx").on(
      table.userId,
      table.platform,
      table.handle
    ),
    index("person_id_idx").on(table.personId),
    index("platform_did_user_idx").on(table.userId, table.platform, table.did),
  ]
);

// Cached posts from any platform
export const posts = mysqlTable(
  "posts",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    postType: varchar("post_type", { length: 20 }).notNull().default("timeline"), // "timeline" | "mention"
    platformIdentityId: int("platform_identity_id")
      .references(() => platformIdentities.id, { onDelete: "cascade" })
      .notNull(),
    platform: varchar("platform", { length: 50 }).notNull(),
    platformPostId: varchar("platform_post_id", { length: 255 }).notNull(),
    platformPostCid: varchar("platform_post_cid", { length: 255 }),
    postUrl: text("post_url"),
    content: text("content"),
    contentHtml: text("content_html"),
    media: json("media"),
    replyToId: varchar("reply_to_id", { length: 255 }),
    repostOfId: varchar("repost_of_id", { length: 255 }),
    quotedPost: json("quoted_post"),
    linkCard: text("link_card"),
    likeCount: int("like_count").default(0),
    repostCount: int("repost_count").default(0),
    replyCount: int("reply_count").default(0),
    postedAt: timestamp("posted_at").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    dedupeHash: varchar("dedupe_hash", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("platform_post_user_type_idx").on(
      table.userId,
      table.platform,
      table.platformPostId,
      table.postType
    ),
    index("identity_posted_idx").on(
      table.platformIdentityId,
      table.postedAt
    ),
    index("dedupe_hash_idx").on(table.dedupeHash),
    index("posted_at_idx").on(table.postedAt),
    index("user_type_posted_idx").on(table.userId, table.postType, table.postedAt),
  ]
);

// Candidate matches between platform identities, staged for review
export const matchSuggestions = mysqlTable(
  "match_suggestions",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
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
    personId: int("person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("suggestion_pair_user_idx").on(
      table.userId,
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
    userId: int("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    platform: varchar("platform", { length: 50 }).notNull(),
    handle: varchar("handle", { length: 255 }).notNull(),
    did: varchar("did", { length: 255 }),
    instanceUrl: varchar("instance_url", { length: 255 }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at"),
    lastSyncAt: timestamp("last_sync_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("connected_platform_user_idx").on(
      table.userId,
      table.platform,
      table.handle
    ),
  ]
);
