INSERT INTO revision (id, version) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER carrier_binding BEFORE UPDATE ON calls
WHEN json_extract(OLD.data, '$.verification.status') = 'eligible'
AND json_extract(OLD.data, '$.verification') IS NOT json_extract(NEW.data, '$.verification')
BEGIN SELECT RAISE(ABORT, 'immutable_carrier'); END;
--> statement-breakpoint
CREATE TRIGGER final_snapshot BEFORE UPDATE ON calls
WHEN json_extract(OLD.data, '$.finalSnapshot') IS NOT NULL
AND json_extract(OLD.data, '$.finalSnapshot') IS NOT json_extract(NEW.data, '$.finalSnapshot')
BEGIN SELECT RAISE(ABORT, 'immutable_snapshot'); END;
--> statement-breakpoint
CREATE TRIGGER quote_carrier BEFORE INSERT ON quotes
WHEN NOT EXISTS (SELECT 1 FROM quotes WHERE id = NEW.id)
AND NOT EXISTS (SELECT 1 FROM calls WHERE id = json_extract(NEW.data, '$.callId')
  AND json_extract(data, '$.verification.carrierId') = json_extract(NEW.data, '$.carrierId')
  AND json_extract(data, '$.record.endedAt') IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_quote_context'); END;
--> statement-breakpoint
CREATE TRIGGER agreement_carrier BEFORE INSERT ON agreements
WHEN NOT EXISTS (SELECT 1 FROM agreements WHERE id = NEW.id)
AND NOT EXISTS (SELECT 1 FROM calls WHERE id = json_extract(NEW.data, '$.callId')
  AND json_extract(data, '$.verification.carrierId') = json_extract(NEW.data, '$.carrierId')
  AND json_extract(data, '$.record.endedAt') IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_context'); END;
