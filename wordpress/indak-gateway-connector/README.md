# Indak Gateway Connector

A lightweight companion installed beside Novamira. It pairs one WordPress installation with
the Indak MCP Gateway and authenticates the gateway only on the exact Novamira MCP endpoint.

## Install

1. Zip the `indak-gateway-connector` folder.
2. In WordPress, open Plugins → Add New Plugin → Upload Plugin.
3. Activate it.
4. Open Settings → Indak Gateway.
5. Generate a one-time code in the gateway Site Manager and paste it into the form.

## Security boundaries

- Only administrators with `manage_options` can pair or disconnect.
- Every site generates its own 256-bit credential.
- WordPress stores only a keyed digest, not the bearer credential.
- The bearer credential authenticates only the exact `rest_url('mcp/novamira')` path.
- The service user is blocked from interactive login.
- Pairing uses `wp_safe_remote_post`, HTTPS verification, and no redirects.

## Important files

- `indak-gateway-connector.php`: plugin composition and hooks.
- `includes/class-authenticator.php`: exact-route bearer authentication.
- `includes/class-pairing-client.php`: one-time gateway claim.
- `admin/class-settings-page.php`: nonce- and capability-protected UI.

## Verification

```bash
bash scripts/connector-lint.sh
php scripts/connector-credential-selftest.php
```

Full release verification also requires pairing on a disposable WordPress staging site and
confirming that unrelated REST routes reject the same bearer token.
