# Changelog

All notable changes to the Indak WP Gateway are documented here.

## 1.2.0 and connector 0.2.0 - 2026-09-22

Connections no longer drop, and no connection problem needs a database edit to fix.

### Fixed

- **Idle sites stopped working until a restart or re-pair.** Novamira ends an MCP session
  after 4 hours idle (and evicts the oldest session per user), answering HTTP 404 with
  JSON-RPC `-32005`. The gateway reported that as "no MCP endpoint", never retried, and kept
  the dead session forever. It now classifies adapter errors by JSON-RPC code, starts a new
  session and retries once, and renews sessions idle for 3 hours before Novamira rejects them.
- **Renamed adapter tools** (JSON-RPC `-32003`, also HTTP 404) are rediscovered, retried, and
  saved, instead of failing until re-pair.
- **Disconnect in WordPress left the gateway record active.** The connector now tells the
  gateway, which disables the site and erases its stored credential. The WordPress notice
  says honestly whether the gateway was told.
- **Re-pairing a site failed with a duplicate-key error** until rows were deleted by hand.
  Re-pairing the same key and endpoint now replaces the old record in place, removed rows
  never block a new pairing, and conflicts with a different active site are refused when the
  code is created, with instructions.
- **A MySQL outage at boot hid every paired site until the next restart.** The gateway retries
  with backoff and refreshes paired sites every five minutes.
- **A pairing whose WordPress request timed out** could be active on the gateway but forgotten
  in WordPress. Timeouts are aligned (gateway callback 20s, WordPress claim 45s), and an
  unanswered claim leaves WordPress in a "Connection not confirmed" state with Check
  connection and Start over buttons.
- **Rotating WordPress salts broke the connection.** The connector's credential digest no
  longer depends on `wp_salt()`. Sites paired with 0.1.0 upgrade on the gateway's next call.
- A leftover `SITES` entry with the same key no longer shadows a paired site, and no longer
  takes the route back after the paired site is removed or disconnected, even if the site is
  later paired under a different key.
- Concurrent calls to one site could wipe each other's new session, or fail after another call
  had already rediscovered renamed tools; retries now act only on what that call sent. Pairing and test callbacks have one overall 20-second deadline
  that also covers reading the response body.
- The gateway answered 400 for failures after a pairing was saved, so WordPress discarded a
  credential the gateway had already activated. Only definite refusals are 4xx now; an unknown
  outcome is 5xx, which leaves WordPress in "Connection not confirmed".
- WordPress no longer clears a connection it did not write (double-click, second tab, or a
  resubmitted form; pairing takes an atomic database lock), waits two minutes before treating an unconfirmed pairing as failed, and
  explains when a site's address changed since pairing.
- An exact site key now wins over a similarly named key (`strengthen-nd` vs `strengthennd`), and
  an ambiguous name is refused instead of guessed.
- Migration 002 can be re-run safely after an interruption (MySQL 8 and MariaDB).

### Security

- **Connector 0.1.0's credential was not limited to the MCP route.** WordPress lets a
  `rest_route` query or form parameter override the route in the URL path, so
  `/wp-json/mcp/novamira?rest_route=/wp/v2/users/me` authenticated the service administrator
  on any REST route. 0.2.0 authenticates only on the REST dispatch pass whose dispatched route
  is the saved MCP route, refuses smuggled `rest_route` parameters, and fences dispatch with
  `rest_pre_dispatch`. Verified against WordPress 7.1.2 with Novamira 1.12.4.
- **Pairing could make an outsider an administrator** (0.1.0). The connector promoted any
  existing user named `indak-gateway-bot`, so on a site with open registration someone could
  register that name first. 0.2.0 only uses an account it created (recorded by ID), refuses
  to pair if a foreign account holds the name, and adopts a 0.1.0 account only if it is
  already an administrator, resetting its password, sessions, and application passwords.
- The service account's login block checked only the typed username, so signing in with its
  email address got through. It now checks the resolved account, and password resets and
  Application Passwords are blocked for it. It has no role while the plugin is inactive or
  uninstalled, and whenever it gets the administrator role back its password, sessions,
  application passwords, and email are reset first. A reinstalled connector recognizes its
  own account, and on multisite every subsite shares it.
- **One malformed request could crash the gateway** (a request line such as `GET //[`), cutting
  off every site until the next restart. The handler now answers 400/500 instead.
- Rate limits used the hosting proxy's address, so one anonymous client could exhaust the
  pairing and connector limits for the whole fleet. Connector calls are now authenticated
  first and only failures are limited (per site key), so a site's own connector is never
  refused; refused requests no longer count; and `TRUST_PROXY_HOPS=1` makes limits and audit
  logs use the real client address behind Hostinger's proxy.
- The release workflow uses no third-party actions and pins GitHub's own by commit; only a
  separate job can publish, and only the zip.
- WordPress notices no longer take their text from the query string.
- Connector updates install only this repository's release asset for the offered version, and
  only if it matches the SHA-256 digest GitHub recorded for it.

### Added

- Site Manager: accepts a plain site URL, shows each site's connector version and last check
  or error, and has per-site Test, Pair again, and Remove actions. Pairing codes come with a
  one-click link that opens the connector with the code filled in.
- Gateway: `POST /connector/status` and `POST /connector/disconnect` for the connector,
  authenticated by a management token derived from the pairing credential;
  `POST /admin/sites/{key}/verify`; `DELETE /admin/sites/{key}`; `GET /connector/release`.
- Gateway records upstream failures and successes from real traffic, so a broken site shows
  in the Site Manager without anyone testing it.
- Connector: Test connection, gateway status on the settings page, default gateway
  `https://gateway.indakmedia.com` (overridable with `INDAK_GATEWAY_URL`, and the old
  temporary Hostinger domain is mapped to it), and self-updates from GitHub releases through
  WordPress's `Update URI` support.
- Migration `002_connector_version.sql`. Pending migrations now run when the gateway starts
  (set `DB_AUTO_MIGRATE=false` to opt out).
- Release workflow checks that the tag matches the plugin version and runs the connector tests.
- Self-tests: `selftest:upstream` (adapter session and tool recovery) and
  `scripts/gateway-lifecycle-selftest.js` (full HTTP lifecycle against MariaDB).

### Upgrade notes

- Deploy the gateway first; connector 0.1.0 keeps working against it.
- Connector 0.1.0 cannot update itself. Install 0.2.0 on each site once; later releases
  arrive through WordPress updates.
- Tag `connector-v0.2.0` to publish the first GitHub release (the `connector-v0.1.0` tag was
  pushed before the release workflow existed, so no release asset was ever built).

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
