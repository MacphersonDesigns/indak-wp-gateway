# Connector Pairing Protocol

## Why this approach

A permanent fleet-wide enrollment key would turn one compromised client site into a path to
the whole fleet. Pairing therefore uses a short-lived, single-use code bound to one expected
WordPress origin. After pairing, each site receives a unique credential that is valid only
for that site's exact Novamira MCP route.

## Actors

- **Gateway manager:** authenticated with `GATEWAY_ADMIN_TOKEN`.
- **Gateway:** the Hostinger Node Web App.
- **Connector:** the Indak Gateway Connector plugin running inside WordPress.
- **Novamira:** the MCP provider installed beside the connector.

## Pairing sequence

1. A manager opens the gateway Site Manager and enters the site's URL. A bare site or
   subdirectory URL gets `/wp-json/mcp/novamira` appended; a full MCP URL is kept as entered.
2. The gateway normalizes the URL into an HTTPS origin and exact path.
3. The manager chooses `staging` or `live`; `writes` defaults to `true` only for staging.
4. The gateway generates a cryptographically random pairing code with a ten-minute expiry.
5. MySQL stores only an HMAC digest of the code, never the reusable plaintext.
6. The manager pastes the displayed code into the connector's WordPress settings page.
7. The connector sends the code and `home_url()` to `POST /pairings/details`. The gateway
   returns the exact manager-approved MCP URL without consuming the code. This supports all
   Novamira route variants and WordPress subdirectory builds.
8. The connector sends that exact URL, the code, and connector version to
   `POST /pairings/claim` over HTTPS.
9. The gateway atomically verifies that the code is unused, unexpired, and bound to the
   connector's normalized WordPress origin.
10. The connector creates a 256-bit site credential, stores only a one-way digest and the
   derived management token locally, and includes the one-time plaintext credential in the
   HTTPS claim.
11. The gateway encrypts that credential with AES-256-GCM and never returns it in a response.
12. The gateway tests `initialize` and `tools/list` against the exact MCP URL using the new
    credential. The site becomes active only when all three required upstream tools resolve.
13. The pairing code is consumed whether validation succeeds or fails. A retry requires a
    new code, preventing online guessing and ambiguous partial enrollment.

## Re-pairing

A new code for a key that is already connected replaces that site's record in place when the
claim succeeds: new credential, same row, history kept. The Site Manager says so when it
creates the code. This is the recovery path for any broken connection, and it never requires
editing the database.

- A removed (disabled) row never blocks a new pairing. Its key can move to a new endpoint, and
  a new key can take over its endpoint.
- A different site that is still active on the same key or endpoint is a conflict. The code is
  refused when it is created, and the claim re-checks inside a locking transaction.
- A paired site wins over a `SITES` entry with the same key; the stale line is reported on the
  gateway's status page.

## Connector authentication

For a gateway request, the connector accepts:

```text
Authorization: Bearer <unique-site-credential>
```

The connector authenticates that token only when all of these are true:

- WordPress is serving the request through the REST API (`REST_REQUEST`). The early
  `determine_current_user` pass, before routing is known, never authenticates.
- The route WordPress will dispatch (`$wp->query_vars['rest_route']`) is exactly the saved MCP
  route, and the request URL path is exactly the saved MCP path.
- No `rest_route` parameter is present in the query string or a form body. WordPress lets such
  a parameter override the route in the URL path; connector 0.1.0 checked only the path, so
  its credential worked on every REST route.
- The token is 43 base64url characters and matches the stored digest in constant time.
- The connector is paired and not locally disconnected.

A `rest_pre_dispatch` fence then refuses the request with 403 if the first route dispatched
after that authentication is not the MCP route. Later dispatches in the same request are
Novamira abilities making internal sub-requests and are allowed.

The connector maps a valid request to a dedicated, non-interactive WordPress service user.
The user has no known login password. The token is not accepted by other REST routes,
`wp-login.php`, XML-RPC, or the WordPress Application Password subsystem.

The service user is identified by the ID the connector recorded when it created it (a network
option, so every multisite subsite shares it, and kept through uninstall), never by its public
login name alone. Pairing refuses to continue if another account already holds the name. A
0.1.0 account (created before IDs were recorded) is adopted only if it is already an
administrator. The account cannot sign in by username or email, cannot reset its password,
cannot use Application Passwords, and has no role while the plugin is inactive or
uninstalled. Whenever it is adopted or given the administrator role back, its password,
sessions, application passwords, and email are reset first.

The stored digest is a domain-separated HMAC-SHA-256 of the credential. It does not depend on
`wp_salt()`, so rotating WordPress salts does not break the connection. Digests written by
connector 0.1.0 (keyed with `wp_salt('auth')`) are verified once and rewritten in the new
format on the next successful gateway call.

## Connector management calls

WordPress holds only a one-way digest of the MCP credential, so it cannot present that
credential again. For its own calls to the gateway it presents a management token derived from
the credential when it was created:

```text
management = HMAC-SHA-256(key = credential, message = "indak-gateway-connector/management/v1")
```

The gateway recomputes the token from the encrypted credential it already stores, so nothing
new is exchanged or kept in MySQL. The token cannot be turned back into the MCP credential and
authorizes only these two calls for its own site, bound to the site's origin:

- `POST /connector/status` with `{ site_key, home_url, verify?, connector_version }`: whether
  the gateway still routes to this site; with `verify: true`, a live `initialize` and
  `tools/list` round trip.
- `POST /connector/disconnect` with `{ site_key, home_url, connector_version }`: disable the
  site and erase its stored credential.

A wrong token, an unknown key, and a disabled site all get the same 404, so the endpoints do
not reveal which sites are paired. Requests are authenticated first and only failures are
limited, per site key (30 a minute), so junk naming a site's key never blocks that site's own
connector. With `TRUST_PROXY_HOPS` set, each real client address is also limited to 120 a
minute.

## Pairing-code format and storage

- Randomness: at least 128 bits from `crypto.randomBytes()`.
- Display: grouped uppercase hexadecimal for transcription; grouping characters are ignored.
- Lifetime: ten minutes by default.
- Attempts: at most five failed claim attempts before invalidation.
- Storage: HMAC-SHA-256 using `REGISTRY_ENCRYPTION_KEY` as key material plus a domain label.
- Binding: expected normalized HTTPS origin and requested environment.
- Consumption: one successful claim or terminal validation attempt.
- The Site Manager also returns a link to the connector's settings page with the code in the
  `indak_gateway_code` query parameter. The code is single use, expires in ten minutes, and is
  useless without control of the bound WordPress site; WordPress removes the parameter from
  the address bar after the page loads. The gateway URL is never taken from a link.

## Credential rotation

Re-pairing is the rotation mechanism: a new code produces a new credential, and the claim
replaces the old one atomically. The old credential stops working on the gateway at once and
in WordPress as soon as the new digest is stored.

## Disconnection

- **From WordPress:** the connector calls `/connector/disconnect`, then always deletes its
  local digest, management token, and state (deleting the digest is what revokes the
  gateway's access). If the gateway could not be told, the notice says so; the gateway then
  reports the site as failing until a manager removes it or the site is paired again, which
  replaces the record.
- **From the gateway:** Remove in the Site Manager disables the site immediately and erases
  its encrypted credential from the row. WordPress shows "Connection problem" on its next
  status check.
- Disconnection never deletes general WordPress content or Novamira configuration.

## Timeouts and answer codes

WordPress waits up to 45 seconds for a claim. The gateway's whole callback to WordPress during
the claim (initialize, notification, and tools/list, including reading each response) has one
20-second deadline, so the gateway answers first.

The claim's status code tells WordPress what to do with the credential it offered:

- **4xx** means a definite refusal (invalid or expired code, wrong endpoint, the gateway could
  not reach the site with the new credential, a conflict). Nothing was stored; WordPress
  discards the credential.
- **5xx**, a timeout, or no answer means the outcome is unknown. WordPress keeps the credential
  pending; Check connection asks `/connector/status` whether the pairing completed, and treats
  "not found" within two minutes of the claim as "not finished yet". Start over discards it.
- Bookkeeping after the pairing is saved (connector version, audit log) never turns a saved
  pairing into an error.

WordPress runs one pairing at a time (an atomic lock), and a failed attempt only clears the
credential that attempt stored.

## Failure behavior

- Pairing and management failures use ordinary HTTP problem responses because they are not
  MCP tool results.
- MCP guardrail refusals retain the current `{ content, isError: true }` result shape.
- Database unavailability does not remove the environment fallback registry, and the gateway
  retries the database with backoff instead of waiting for a restart.
- A database-only site is reported unavailable with an actionable message; it is never
  silently routed elsewhere.
- Upstream sessions that Novamira has ended (HTTP 404, JSON-RPC `-32005`) are replaced and the
  call retried once. Unknown adapter tools (`-32003`) are rediscovered and retried once.
