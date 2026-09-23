-- Record which connector release each paired site runs, so the Site Manager can show which
-- sites still need a connector update. Existing rows are backfilled from their most recent
-- pairing audit event; sites paired before that event existed stay NULL until they report.

-- Guarded so a run interrupted after this step can be retried (the runner records a file only
-- after all of it succeeds). Works on MySQL 8 and MariaDB, which differ on ADD COLUMN IF NOT EXISTS.
SET @indak_add_connector_version = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sites' AND COLUMN_NAME = 'connector_version') = 0,
  'ALTER TABLE sites ADD COLUMN connector_version VARCHAR(32) NULL AFTER timeout_ms',
  'DO 0'
);
PREPARE indak_add_connector_version FROM @indak_add_connector_version;
EXECUTE indak_add_connector_version;
DEALLOCATE PREPARE indak_add_connector_version;

UPDATE sites
  JOIN (
    SELECT site_id, MAX(id) AS latest_event_id
      FROM registry_audit_events
     WHERE event_type = 'site_paired' AND site_id IS NOT NULL
     GROUP BY site_id
  ) latest ON latest.site_id = sites.id
  JOIN registry_audit_events events ON events.id = latest.latest_event_id
   SET sites.connector_version = LEFT(JSON_UNQUOTE(JSON_EXTRACT(events.details_json, '$.connector_version')), 32)
 WHERE sites.connector_version IS NULL;
