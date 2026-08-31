# Changelog

All notable changes to the Indak WP Gateway are documented here.

## 1.1.0 - 2026-08-30

### Added

- Docker Compose MariaDB service with persistent local storage.
- Forward-only MySQL migration runner and initial site-registry schema.
- Exactly pinned `mysql2` database transport as the sole production dependency.
- AES-256-GCM credential module with endpoint-bound authenticated data.
- Parameterized paired-site repository and conflict-aware environment registry merge.
- Degraded database startup that preserves healthy environment-backed sites.
- Host-bound, expiring pairing-code service with immediate scoped-auth callback validation.
- Redirect refusal and five-megabyte upstream response limit.
- Initial Indak Gateway Connector plugin with one-time pairing, exact-route bearer
  authentication, protected settings UI, and interactive service-login blocking.
- Keyboard-accessible, responsive Site Manager page for creating codes and listing paired sites.
- Reproducible connector ZIP build with archive-integrity verification.
- Hostinger production guidance pins `DB_HOST` to IPv4 loopback to avoid an IPv6 MySQL grant
  mismatch observed in the managed Node 22 runtime.
- Product requirements for team-manageable WordPress site enrollment.
- Host-bound, single-use connector pairing protocol.
- Hostinger MySQL registry schema with AES-256-GCM credential encryption.
- Repository-grounded threat model for the gateway, database, and connector trust boundaries.
- Architecture decisions covering MySQL, the single `mysql2` dependency, and MCP-only site
  credentials.

### Compatibility

- The existing `SITES`, JSON registry, four MCP tools, refusal shape, and live-site guardrails
  remain unchanged while the database enrollment system is built.
