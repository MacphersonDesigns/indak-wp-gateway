# Architecture Decisions

## 2026-08-30 — Pair sites instead of configuring each through Hostinger

**Decision:** Add a lightweight WordPress connector and a gateway Site Manager using
single-use pairing codes.

**Why:** Forty-plus sites would require more than eighty environment entries and repeated
redeployments. Pairing lets an authorized manager and WordPress administrator onboard a site
without learning registry syntax or handling an administrator Application Password.

**Alternatives considered:** Continue `SITES`; store an encrypted registry in GitHub; use a
fleet-wide enrollment secret. The first does not scale, the second couples runtime state to
deployments, and the third creates an unacceptable cross-site compromise path.

## 2026-08-30 — Use Hostinger MySQL with one pinned dependency

**Decision:** Use the MySQL database assigned to the Hostinger Web App and permit `mysql2` as
the gateway's only production dependency.

**Why:** The managed deployment filesystem is not reliable registry storage. Calling the
`mysql` CLI or implementing the MySQL wire protocol would be fragile and unsafe. The original
reason for zero dependencies—avoiding MCP SDK churn—still holds because the protocol layer
remains hand-rolled.

**Consequence:** `mysql2` must be pinned, audited, and covered by both-load and failure tests.

## 2026-08-30 — Use scoped per-site credentials

**Decision:** The connector accepts a unique bearer credential only on the exact Novamira MCP
path. Do not generate WordPress Application Passwords for paired sites.

**Why:** An Application Password attached to an administrator can authenticate beyond the
intended MCP route. Route-scoped credentials reduce the blast radius of a leaked site secret.

## 2026-09-22 — Re-pairing replaces the old record

**Decision:** A claim for an existing key and endpoint updates that row in place. Removed rows
never block pairing; only a different, still-active site is a conflict.

**Why:** Every recovery path used to end in deleting MySQL rows by hand, which the team cannot
do. The pairing code is manager-issued and the claim proves control of the WordPress site, so
replacing that site's own credential needs no further approval.

## 2026-09-22 — Derive the connector's management token from its credential

**Decision:** Status and disconnect calls from WordPress use
`HMAC-SHA-256(credential, "indak-gateway-connector/management/v1")`.

**Why:** WordPress keeps only a digest of the MCP credential, and the gateway can recompute
the token from the ciphertext it already stores. No second secret is exchanged or stored in
MySQL, and the token cannot be turned back into the credential. Alternatives were storing the
credential in WordPress (breaks the one-way-digest property) or a separately issued secret
(more state for no gain).

## 2026-09-22 — Authenticate on the dispatched REST route

**Decision:** The connector checks `REST_REQUEST`, the dispatched `rest_route`, the absence of
`rest_route` request parameters, and the URL path, then fences the first dispatch.

**Why:** WordPress lets `rest_route` in the query or a form body override the path, so a
path-only check let the credential reach every REST route as an administrator (confirmed in
WordPress 7.1.2).

## 2026-09-22 — Paired sites win over environment entries with the same key

**Decision:** Reverse the rollout-era precedence.

**Why:** A paired site was verified end to end when it was paired and can be changed without
a redeploy. Keeping a stale `SITES` line authoritative silently ignored the paired credential.

## 2026-09-22 — Ship connector updates through the gateway's release feed

**Decision:** The connector asks `GET /connector/release`, which caches GitHub's release list
for an hour, and installs only this repository's asset for that version after checking its
SHA-256 digest.

**Why:** Dozens of client sites share a few hosting IP addresses, which would exhaust GitHub's
60-requests-per-hour unauthenticated limit. The gateway is not trusted with the code: the
package URL is fixed per version and the digest is checked on the site.
