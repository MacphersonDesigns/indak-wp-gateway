# Indak Gateway Site Enrollment PRD

## Problem

The gateway currently needs one `SITES` registry entry and one `WP_PW_*` environment
variable for every WordPress installation. That is acceptable for one or two sites, but it
does not scale to the 40+ installations the Indak team expects to manage. It also requires
Hostinger access and knowledge of MCP endpoint paths for routine onboarding.

## Outcome

An authorized Indak manager can create a one-time pairing code. A WordPress administrator
installs the Indak Gateway Connector beside Novamira, enters that code, and the site becomes
available through the gateway without editing Hostinger variables or redeploying.

## Success criteria

- Pair a WordPress site in under five minutes after both plugins are installed.
- Accept subdirectory endpoints such as `/divi/wp-json/mcp/novamira` without manual parsing.
- Never share one site credential between two WordPress installations.
- Never expose a stored credential through the administration API or interface.
- A compromised client site cannot read, modify, or impersonate another registered site.
- Live sites remain read-only by default and retain the existing live-root refusal.
- The gateway continues serving the current environment registry during migration.
- The MCP surface remains exactly four tools.

## Users

- **Indak manager:** creates pairing codes and manages registered sites.
- **WordPress administrator:** installs the connector and completes pairing.
- **ClickUp team member:** uses the existing four MCP tools; does not manage enrollment.

## First-release scope

- Hostinger MySQL persistence.
- Protected pairing-code API.
- Minimal protected site-management page.
- Lightweight WordPress connector plugin.
- Unique MCP-only credential per site.
- Credential rotation and disconnection.
- Environment-registry fallback and one-time import.
- JSON-lines audit events for every administrative action.

## Explicitly deferred

- Per-person ClickUp identity.
- OAuth or SSO for the administration page.
- Multi-organization tenancy.
- Automatic Novamira installation or updates.
- Removing the existing `SITES` loader.
