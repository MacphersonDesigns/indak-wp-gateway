# Indak Gateway Connector

A lightweight companion installed beside Novamira. It pairs one WordPress installation with
the Indak MCP Gateway and authenticates the gateway only on the exact Novamira MCP endpoint.

## Install

1. Download `indak-gateway-connector.zip` from the latest `connector-v*` release of
   `MacphersonDesigns/indak-wp-gateway`, or let the Indak Partnership Program installer do it.
2. In WordPress, open Plugins → Add New Plugin → Upload Plugin, and activate it.
3. In the gateway Site Manager, create a pairing code and choose **Open the connector on …**,
   or open Settings → Indak Gateway and paste the code.
4. Choose **Connect to Indak Gateway**.

The gateway address defaults to `https://gateway.indakmedia.com`. To pin another one, add
`define('INDAK_GATEWAY_URL', 'https://…');` to `wp-config.php`.

## Updates

From 0.2.0 the connector updates like any other plugin. Its `Update URI` header points
WordPress at this repository instead of WordPress.org, and the gateway's `/connector/release`
feed says which release is newest. WordPress installs only this repository's release asset
for that version, and only if the download matches the SHA-256 digest GitHub recorded for
it. Enable auto-updates for the plugin on the Plugins screen if you want fixes to arrive
without clicking Update. Sites on 0.1.0 need 0.2.0 installed by hand once.

## Settings → Indak Gateway

- **Connected:** gateway status, site key, environment, endpoint, and connector version, with
  **Test connection** (a live round trip through the gateway) and **Disconnect this site**.
- **Connection not confirmed:** the gateway did not answer a pairing in time. **Check
  connection** asks whether it completed; **Start over** discards it.
- **Connect this site:** gateway URL and pairing code.

Disconnect tells the gateway to remove the site and then always clears the local credential.
If the gateway cannot be reached, the notice says so, and pairing again later replaces the
gateway's old record.

## Security boundaries

- Only administrators with `manage_options` can pair, test, or disconnect.
- Every site generates its own 256-bit credential.
- WordPress stores a one-way digest of the credential and a derived management token, never
  the credential. The digest does not depend on WordPress salts.
- The credential authenticates only when WordPress dispatches the saved MCP route through the
  REST API. `rest_route` parameters that would override the route are refused, and
  `rest_pre_dispatch` fences the dispatch. Connector 0.1.0 checked only the URL path, so its
  credential could reach other REST routes; update every 0.1.0 site.
- The service user (`indak-gateway-bot`) is one the connector created and recorded by ID; it
  will not adopt an account someone else registered under that name. It cannot sign in by
  username or email, reset its password, or use Application Passwords, and it has no role
  while the plugin is inactive or uninstalled.
- Pairing uses `wp_safe_remote_post`, HTTPS verification, and no redirects.
- Notices are stored server-side; a link cannot put text on the settings page.

## Important files

- `indak-gateway-connector.php`: plugin composition and hooks.
- `includes/class-authenticator.php`: dispatched-route bearer authentication.
- `includes/class-credential-store.php`: digest, management token, and 0.1.0 upgrade.
- `includes/class-pairing-client.php`: pairing, status, and disconnect calls.
- `includes/class-updater.php`: verified self-updates.
- `admin/class-settings-page.php`: nonce- and capability-protected UI.

## Verification

```bash
bash scripts/connector-lint.sh
php scripts/connector-credential-selftest.php
```

Release verification also pairs on a disposable WordPress with Novamira and confirms that
`?rest_route=` and form-body overrides, other REST routes, and the front end all reject the
credential while the MCP route and Novamira abilities keep working.
