-- Persistent registry for paired WordPress sites.
--
-- Credentials are encrypted in Node before reaching this schema. MySQL never receives
-- plaintext site credentials or the encryption key.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sites (
  id CHAR(36) NOT NULL PRIMARY KEY,
  site_key VARCHAR(80) NOT NULL,
  label VARCHAR(180) NOT NULL,
  origin VARCHAR(255) NOT NULL,
  mcp_path VARCHAR(512) NOT NULL,
  environment ENUM('staging', 'live') NOT NULL,
  writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status ENUM('pending', 'active', 'disabled', 'error') NOT NULL DEFAULT 'pending',
  credential_ciphertext VARBINARY(512) NULL,
  credential_iv BINARY(12) NULL,
  credential_tag BINARY(16) NULL,
  credential_key_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  credential_fingerprint CHAR(64) NULL,
  upstream_tools_json JSON NULL,
  rate_limit_per_minute SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  timeout_ms INT UNSIGNED NOT NULL DEFAULT 120000,
  last_verified_at TIMESTAMP(6) NULL,
  last_error VARCHAR(500) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY sites_site_key_unique (site_key),
  UNIQUE KEY sites_endpoint_unique (origin, mcp_path)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pairing_codes (
  id CHAR(36) NOT NULL PRIMARY KEY,
  code_digest BINARY(32) NOT NULL,
  expected_origin VARCHAR(255) NOT NULL,
  expected_mcp_path VARCHAR(512) NOT NULL,
  requested_site_key VARCHAR(80) NOT NULL,
  requested_label VARCHAR(180) NOT NULL,
  environment ENUM('staging', 'live') NOT NULL,
  writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at TIMESTAMP(6) NOT NULL,
  consumed_at TIMESTAMP(6) NULL,
  created_by_fingerprint CHAR(16) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY pairing_codes_digest_unique (code_digest),
  KEY pairing_codes_expiry_index (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS registry_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(80) NOT NULL,
  site_id CHAR(36) NULL,
  actor_type ENUM('admin', 'connector', 'system') NOT NULL,
  actor_fingerprint CHAR(16) NULL,
  details_json JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY registry_audit_site_index (site_id, created_at),
  KEY registry_audit_event_index (event_type, created_at),
  CONSTRAINT registry_audit_site_fk FOREIGN KEY (site_id) REFERENCES sites(id)
    ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;
