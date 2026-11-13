CREATE UNIQUE INDEX effective_allocation ON agreements (json_extract(data, '$.load.id')) WHERE json_extract(data, '$.status') = 'effective';--> statement-breakpoint
CREATE UNIQUE INDEX distinct_price ON events (json_extract(data, '$.pairId'), json_extract(data, '$.amountCents')) WHERE json_extract(data, '$.consumed') = 1;--> statement-breakpoint
CREATE UNIQUE INDEX negotiation_pair ON negotiations (json_extract(data, '$.carrierId'), json_extract(data, '$.loadId'));--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_guard` (
	`id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "revision_conflict" CHECK("__new_guard"."valid" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_guard`("id", "valid") SELECT "id", "valid" FROM `guard`;--> statement-breakpoint
DROP TABLE `guard`;--> statement-breakpoint
ALTER TABLE `__new_guard` RENAME TO `guard`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
