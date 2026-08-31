# Site Manager Module

This module owns durable site enrollment. It deliberately does not own MCP tool definitions
or guard decisions; `src/server.js` and `src/guard.js` remain the only places that make those
decisions.

## Boundaries

- `CredentialCipher.js`: encrypts/decrypts one site's scoped credential.
- `Database.js`: creates a small, bounded MySQL pool.
- `SiteRepository.js`: parameterized persistence and row-to-runtime conversion.
- `RegistryMerge.js`: combines paired sites with the legacy environment fallback.

## Local verification

```bash
npm run db:up
DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=indak_gateway \
  DB_USER=indak_gateway DB_PASSWORD=local-development-only npm run db:migrate
node scripts/site-manager-selftest.js
```

The database must never receive plaintext site credentials. Encryption happens before every
write and decryption happens only when building the in-memory runtime registry.
