CREATE TABLE `connected_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`platform` varchar(50) NOT NULL,
	`handle` varchar(255) NOT NULL,
	`did` varchar(255),
	`instance_url` varchar(255),
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` timestamp,
	`last_sync_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `connected_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `connected_platform_idx` UNIQUE(`platform`,`handle`)
);
--> statement-breakpoint
CREATE TABLE `match_suggestions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bluesky_identity_id` int NOT NULL,
	`mastodon_identity_id` int NOT NULL,
	`heuristic_score` float NOT NULL,
	`llm_confidence` float,
	`llm_reasoning` text,
	`status` varchar(20) NOT NULL DEFAULT 'pending',
	`person_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `match_suggestions_id` PRIMARY KEY(`id`),
	CONSTRAINT `suggestion_pair_idx` UNIQUE(`bluesky_identity_id`,`mastodon_identity_id`)
);
--> statement-breakpoint
CREATE TABLE `persons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`display_name` varchar(255),
	`notes` text,
	`auto_matched` boolean DEFAULT false,
	`match_confidence` float,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `persons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `platform_identities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int,
	`platform` varchar(50) NOT NULL,
	`handle` varchar(255) NOT NULL,
	`did` varchar(255),
	`display_name` varchar(255),
	`avatar_url` text,
	`bio` text,
	`profile_url` text,
	`verified_domain` varchar(255),
	`is_followed` boolean NOT NULL DEFAULT false,
	`raw_profile` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platform_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_handle_idx` UNIQUE(`platform`,`handle`)
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`platform_identity_id` int NOT NULL,
	`platform` varchar(50) NOT NULL,
	`platform_post_id` varchar(255) NOT NULL,
	`content` text,
	`content_html` text,
	`media` json,
	`reply_to_id` varchar(255),
	`repost_of_id` varchar(255),
	`like_count` int DEFAULT 0,
	`repost_count` int DEFAULT 0,
	`reply_count` int DEFAULT 0,
	`posted_at` timestamp NOT NULL,
	`fetched_at` timestamp NOT NULL DEFAULT (now()),
	`dedupe_hash` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `posts_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_post_idx` UNIQUE(`platform`,`platform_post_id`)
);
--> statement-breakpoint
ALTER TABLE `match_suggestions` ADD CONSTRAINT `match_suggestions_bluesky_identity_id_platform_identities_id_fk` FOREIGN KEY (`bluesky_identity_id`) REFERENCES `platform_identities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `match_suggestions` ADD CONSTRAINT `match_suggestions_mastodon_identity_id_platform_identities_id_fk` FOREIGN KEY (`mastodon_identity_id`) REFERENCES `platform_identities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `match_suggestions` ADD CONSTRAINT `match_suggestions_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_identities` ADD CONSTRAINT `platform_identities_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `posts` ADD CONSTRAINT `posts_platform_identity_id_platform_identities_id_fk` FOREIGN KEY (`platform_identity_id`) REFERENCES `platform_identities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `suggestion_status_idx` ON `match_suggestions` (`status`);--> statement-breakpoint
CREATE INDEX `person_id_idx` ON `platform_identities` (`person_id`);--> statement-breakpoint
CREATE INDEX `identity_posted_idx` ON `posts` (`platform_identity_id`,`posted_at`);--> statement-breakpoint
CREATE INDEX `dedupe_hash_idx` ON `posts` (`dedupe_hash`);--> statement-breakpoint
CREATE INDEX `posted_at_idx` ON `posts` (`posted_at`);