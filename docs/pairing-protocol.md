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

1. A manager opens the gateway Site Manager and enters the site's full Novamira MCP URL.
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
10. The connector creates a 256-bit site credential, stores only its keyed digest locally,
   and includes the one-time plaintext credential in the HTTPS claim.
11. The gateway encrypts that credential with AES-256-GCM and never returns it in a response.
12. The gateway tests `initialize` and `tools/list` against the exact MCP URL using the new
    credential. The site becomes active only when all three required upstream tools resolve.
13. The pairing code is consumed whether validation succeeds or fails. A retry requires a
    new code, preventing online guessing and ambiguous partial enrollment.

## Connector authentication

For a gateway request, the connector accepts:

```text
Authorization: Bearer <unique-site-credential>
```

The connector authenticates that token only when all of these are true:

- The request path exactly matches the saved Novamira MCP path.
- The token digest matches using constant-time comparison.
- The connector is paired and not locally disconnected.
- The request is HTTPS, except in an explicitly enabled local development environment.

The connector maps a valid request to a dedicated, non-interactive WordPress service user.
The user has no known login password. The token is not accepted by other REST routes,
`wp-login.php`, XML-RPC, or the WordPress Application Password subsystem.

## Pairing-code format and storage

- Randomness: at least 128 bits from `crypto.randomBytes()`.
- Display: grouped uppercase base32 for transcription; grouping characters are ignored.
- Lifetime: ten minutes by default.
- Attempts: at most five failed claim attempts before invalidation.
- Storage: HMAC-SHA-256 using `REGISTRY_ENCRYPTION_KEY` as key material plus a domain label.
- Binding: expected normalized HTTPS origin and requested environment.
- Consumption: one successful claim or terminal validation attempt.

## Rotation

1. A manager requests rotation from the Site Manager.
2. The gateway creates a short-lived rotation challenge bound to the existing site ID.
3. The WordPress connector confirms the challenge while authenticated with the current
   credential.
4. A new credential is exchanged and verified.
5. The old credential remains valid for no more than 60 seconds to cover in-flight calls.
6. Both systems audit the rotation without logging either credential.

## Disconnection

- **From WordPress:** the connector deletes its digest and notifies the gateway when reachable.
- **From the gateway:** the site is disabled immediately and its encrypted credential is
  cryptographically erased from the active row.
- Disconnection never deletes general WordPress content or Novamira configuration.

## Failure behavior

- Pairing and management failures use ordinary HTTP problem responses because they are not
  MCP tool results.
- MCP guardrail refusals retain the current `{ content, isError: true }` result shape.
- Database unavailability does not remove the environment fallback registry.
- A database-only site is reported unavailable with an actionable message; it is never
  silently routed elsewhere.
