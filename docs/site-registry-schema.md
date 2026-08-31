# Site Registry Schema

## Storage choice

Production uses the Hostinger MySQL database assigned to the gateway Web App. Local
development uses MariaDB through Docker Compose. `mysql2` is the only runtime dependency;
the MCP protocol remains hand-rolled and SDK-free.

## Tables

### `schema_migrations`

| Column | Type | Purpose |
|---|---|---|
| `version` | `VARCHAR(64)` primary key | Immutable migration identifier. |
| `applied_at` | `TIMESTAMP(6)` | When the migration completed. |

### `sites`

| Column | Type | Purpose |
|---|---|---|
| `id` | `CHAR(36)` primary key | Stable UUID, never derived from a URL. |
| `site_key` | `VARCHAR(80)` unique | Human-facing MCP routing key. |
| `label` | `VARCHAR(180)` | Name shown to Brain and Site Manager. |
| `origin` | `VARCHAR(255)` | Normalized HTTPS origin only. |
| `mcp_path` | `VARCHAR(512)` | Exact absolute Novamira MCP path. |
| `environment` | `ENUM('staging','live')` | Drives live-root protection. |
| `writes_enabled` | `BOOLEAN` | Defaults false for live and true for staging. |
| `status` | `ENUM('pending','active','disabled','error')` | Explicit lifecycle state. |
| `credential_ciphertext` | `VARBINARY(512)` | AES-256-GCM encrypted credential. |
| `credential_iv` | `BINARY(12)` | Unique GCM nonce. |
| `credential_tag` | `BINARY(16)` | GCM authentication tag. |
| `credential_key_version` | `SMALLINT UNSIGNED` | Supports controlled key rotation. |
| `credential_fingerprint` | `CHAR(64)` | Non-secret SHA-256 fingerprint for diagnostics. |
| `upstream_tools_json` | `JSON` | Discovered three-name mapping cache. |
| `rate_limit_per_minute` | `SMALLINT UNSIGNED` | Defaults to 30. |
| `timeout_ms` | `INT UNSIGNED` | Defaults to 120000. |
| `last_verified_at` | `TIMESTAMP(6) NULL` | Last successful connection test. |
| `last_error` | `VARCHAR(500) NULL` | Sanitized diagnostic, never credentials. |
| `created_at` / `updated_at` | `TIMESTAMP(6)` | Lifecycle timestamps. |

Unique constraints apply to `site_key` and the pair `(origin, mcp_path)`. This prevents two
labels from accidentally routing to one installation while still allowing separate builds
under paths such as `/divi` and `/oxygen` on the same host.

### `pairing_codes`

| Column | Type | Purpose |
|---|---|---|
| `id` | `CHAR(36)` primary key | Pairing attempt identifier. |
| `code_digest` | `BINARY(32)` unique | HMAC digest; plaintext is never stored. |
| `expected_origin` | `VARCHAR(255)` | HTTPS origin supplied by the manager. |
| `expected_mcp_path` | `VARCHAR(512)` | Exact expected endpoint path. |
| `requested_site_key` / `requested_label` | `VARCHAR(...)` | Manager-approved identity. |
| `environment` | `ENUM('staging','live')` | Manager-approved safety classification. |
| `writes_enabled` | `BOOLEAN` | Server forces false when environment is live. |
| `failed_attempts` | `TINYINT UNSIGNED` | Invalidates at five. |
| `expires_at` | `TIMESTAMP(6)` | Ten-minute default expiry. |
| `consumed_at` | `TIMESTAMP(6) NULL` | Enforces single use. |
| `created_by_fingerprint` | `CHAR(16)` | Non-secret admin-token fingerprint. |
| `created_at` | `TIMESTAMP(6)` | Audit correlation. |

### `registry_audit_events`

| Column | Type | Purpose |
|---|---|---|
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | Ordered event ID. |
| `event_type` | `VARCHAR(80)` | For example `site_paired` or `credential_rotated`. |
| `site_id` | `CHAR(36) NULL` | Related site when applicable. |
| `actor_type` | `ENUM('admin','connector','system')` | Source category. |
| `actor_fingerprint` | `CHAR(16) NULL` | Non-secret correlation value. |
| `details_json` | `JSON` | Allowlisted metadata only. |
| `created_at` | `TIMESTAMP(6)` | Event time. |

Audit inserts must never contain pairing codes, bearer tokens, database passwords, plaintext
site credentials, ciphertext fields, request authorization headers, or raw exception dumps.

## Registry precedence during migration

1. Load usable environment/file registry entries as today.
2. Load active database entries.
3. Reject duplicate keys that disagree on endpoint; never silently choose one.
4. For an exact matching key and endpoint, the database row becomes authoritative after a
   successful import marker is recorded.
5. If MySQL is unavailable, continue serving environment entries and report degraded database
   status on health diagnostics.

## Encryption contract

- Algorithm: AES-256-GCM through Node's built-in `crypto` module.
- Master key: 32 bytes decoded from the 64-character `REGISTRY_ENCRYPTION_KEY` hex value.
- Nonce: fresh random 12-byte value for every encryption.
- Additional authenticated data: site UUID, normalized origin, MCP path, and key version.
- No deterministic encryption and no key material in MySQL.
- Decryption failure disables only the affected site and produces a sanitized audit event.
