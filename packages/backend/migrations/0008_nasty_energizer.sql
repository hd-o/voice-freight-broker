CREATE INDEX `analysis_status` ON `analysis` (json_extract(`data`, '$.status'));--> statement-breakpoint
CREATE INDEX `calls_owner_started` ON `calls` (json_extract(`data`, '$.ownerId'), json_extract(`data`, '$.record.startedAt'));--> statement-breakpoint
CREATE INDEX `calls_started` ON `calls` (json_extract(`data`, '$.record.startedAt'));--> statement-breakpoint
CREATE INDEX `calls_ended` ON `calls` (json_extract(`data`, '$.record.endedAt'));--> statement-breakpoint
CREATE INDEX `calls_analysis_status` ON `calls` (COALESCE(json_extract(`data`, '$.finalSnapshot.analysis.status'), json_extract(`data`, '$.record.analysis.status')));
