CREATE INDEX `transcript_call` ON `transcriptFragments` (json_extract(`data`, '$.callId'));
