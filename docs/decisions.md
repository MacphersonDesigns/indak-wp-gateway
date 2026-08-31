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
