CREATE TABLE `liveSessions` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `providerUsage` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "usage_microdollars" CHECK(json_extract("providerUsage"."data", '$.costMicrodollars') >= 0 AND typeof(json_extract("providerUsage"."data", '$.costMicrodollars')) = 'integer')
);
--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "reservation_microdollars" CHECK(json_extract("reservations"."data", '$.reservedMicrodollars') >= 0 AND typeof(json_extract("reservations"."data", '$.reservedMicrodollars')) = 'integer' AND json_extract("reservations"."data", '$.chargedMicrodollars') >= 0 AND typeof(json_extract("reservations"."data", '$.chargedMicrodollars')) = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservation_operation` ON `reservations` (json_extract(data, '$.ownerId'), json_extract(data, '$.operationId'));--> statement-breakpoint
CREATE TABLE `spendingPeriods` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "spending_microdollars" CHECK(json_extract("spendingPeriods"."data", '$.spentMicrodollars') >= 0 AND typeof(json_extract("spendingPeriods"."data", '$.spentMicrodollars')) = 'integer')
);
--> statement-breakpoint
CREATE TABLE `transcriptFragments` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
