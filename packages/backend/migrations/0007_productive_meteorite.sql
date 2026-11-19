CREATE INDEX `transcript_call_sequence` ON `transcriptFragments` (json_extract(`data`, '$.callId'), json_extract(`data`, '$.sequence'));
