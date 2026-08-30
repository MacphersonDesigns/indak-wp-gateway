# Indak WP Gateway

One MCP endpoint fronting every Indak-managed WordPress site running Novamira.

ClickUp registers MCP tools in a flat namespace. Every Novamira install exposes the
same three tool names, so connecting two sites directly means only the first is ever
reachable: the second reports "Connected" and answers nothing. This gateway re-exposes
those tools **once**, with a required `site` parameter, and proxies each call to the
right WordPress install. One ClickUp connection, any number of sites.

**Zero dependencies.** Plain Node 20+, no `npm install`, no `@modelcontextprotocol/sdk`.
The SDK's server API has churned across minor versions and this is ~600 lines of
JSON-RPC over HTTP. Nothing to pin, nothing to break on a redeploy.

## Tool surface

| Tool | Arguments | Purpose |
|---|---|---|
| `wp_list_sites` | none | Turns "the StrengthenND site" into an exact site key. Returns environment and whether writes are on. |
| `wp_discover_abilities` | `site` | That site's abilities plus its theme/plugin environment. |
| `wp_get_ability_info` | `site`, `ability_name` | Schema for one ability. |
| `wp_execute_ability` | `site`, `ability_name`, `parameters` | Does the work. Guarded, see below. |

Four tools, permanently, no matter how many sites you add.

## Safety model

Novamira can execute PHP and write files, so a gateway fronting a dozen client sites is
effectively root on all of them, reachable by everyone holding the token. Four layers:

1. **Per-site `writes` flag.** New sites land with `writes: false` and can only be read.
   Flip it on while a build is in flight, then flip it back.
2. **Default-deny classification.** An ability is a write unless its name clearly reads.
   Unrecognised abilities (Novamira adds them often) count as writes until a human reviews them.
3. **Live-site root block.** PHP execution, file writes, and WP-CLI are refused on any site
   marked `env: "live"` unless `ALLOW_LIVE_ROOT=true` is set deliberately. Do it on staging.
4. **Optional read-only token.** `GATEWAY_TOKEN_READONLY` can read any site but never write.
   Hand that one to account managers.

Plus a per-site rate limit and a JSON-lines audit log of every call (site, ability, caller,
latency, whether it was denied). Refusals come back as tool output rather than protocol
errors, so the agent explains the block to the user instead of retrying blindly.

## Start here (about 30 minutes)

### 1. Prove it works on your laptop, with no WordPress at all

```bash
node scripts/selftest.js
```

This boots two fake Novamira installs and the gateway, then asserts routing and every
guardrail: 21 checks, no network needed. If this is green, the gateway logic is sound and
anything that breaks later is credentials, DNS, or hosting.

### 2. Per site, on WordPress (StrengthenND and Indak first)

- [ ] Novamira active, **Enable AI Abilities** checked, admin bar shows `Novamira ON`
- [ ] Create a dedicated `novamira-bot` **admin** user, not a human account
- [ ] Users > Profile > Application Passwords > generate one named `wp-gateway`, copy it
- [ ] Copy the exact MCP endpoint path from Novamira > Configuration. If it is not
      `/wp-json/mcp-adapter/mcp`, set `mcpPath` for that site in `registry.json`
- [ ] Confirm the site is HTTPS and publicly reachable
- [ ] If Wordfence is active, allowlist the gateway's egress IP or expect random 403s

### 3. Configure

```bash
cp .env.example .env
cp registry.example.json registry.json
openssl rand -hex 32   # -> GATEWAY_TOKEN
openssl rand -hex 32   # -> GATEWAY_TOKEN_READONLY
npm run dev            # boots on :8080, logs every site it loaded and every one it skipped
```

The boot log is the config check. It prints each usable site with its env and writes flag,
and each skipped site with the reason (no base URL, missing secret, http not https).

Leave `ALLOW_LIVE_ROOT` unset. Leave every site at `writes: false`.

### 4. Deploy

Needs a stable public HTTPS hostname: ClickUp cannot reach localhost or an interactive tunnel.

Supply the registry as the **`REGISTRY_JSON` env var** on any host that builds from git.
`registry.json` is gitignored (it names your sites and secret vars), so the env var keeps
secrets out of the repo and makes adding a site an env edit instead of a code push.

**Hostinger** works, on the right plan. hPanel > Websites > Add Website > **Web App**,
deploy from GitHub. Requires **Business Web Hosting** or any **Cloud** plan; Premium and
single shared plans have no Node runtime. Settings:

| Field | Value |
|---|---|
| Framework preset | `Other` |
| Node.js version | 22 |
| Build command | leave empty (zero dependencies, nothing to build) |
| Entry file | `src/server.js` |
| Output directory | leave empty |
| Environment variables | `GATEWAY_TOKEN`, `REGISTRY_JSON`, and one `WP_PW_*` per site |

Hostinger gotchas, in the order you will hit them:

- **Do not set `PORT`.** Hostinger assigns it and passes it in the environment. The server
  reads `process.env.PORT` already. Hardcode it and you get a 503 with a healthy build.
- **The process stops when idle** and starts again on the next request. Fine here: the
  gateway is stateless with no dependencies, so a cold start is fast. Expect the first
  Brain call after a quiet spell to take a beat longer.
- **The domain needs a fresh slot.** If the domain you want is already added as a website,
  remove that website first or the Web App flow refuses to create it.
- **A green build can still be a dead process.** Check Runtime Logs, not the build log.
  Missing env vars are the usual cause.
- **Do not hand-edit the generated `.htaccess`** in `public_html`. Redeploying rewrites it.
- Memory is capped per plan. Irrelevant for this app (no `node_modules` at all), but it is
  why heavier Node apps flake on shared plans.

Use a subdomain you do not care about, like `gateway.indakmedia.com`, not a client domain.

**Railway** is still the smoother path if the Hostinger plan does not already cover it:
push to GitHub, Deploy from GitHub repo, Settings > Networking > Generate Domain. Always-on,
no cold starts, `railway.json` sets the healthcheck. **Fly.io** if you want scale-to-zero:
`fly launch --ha=false --smoke-checks=false`, then `fly secrets set ...`. `fly.toml` included.

Not Cloudflare Workers, at least not first: a non-Node runtime plus subrequest limits, for
something `execute-php` can take 60s to answer.

Whatever you pick: secrets as secrets, never baked into the image, and never commit
`registry.json` or `.env`.

### 5. Verify the deploy (this is the part people skip)

```bash
GATEWAY=https://your-app.up.railway.app TOKEN=<GATEWAY_TOKEN> ./scripts/smoke.sh
```

- [ ] `GET /healthz` returns `{"ok":true,"sites":2}`
- [ ] `tools/list` returns exactly 4 tools
- [ ] `strengthennd` answers with **its own** theme and plugin list
- [ ] `indak` answers in the same run. Both reachable together is the entire point; if one
      goes quiet, stop and fix the gateway before going further
- [ ] `execute-php` is **refused** with the writes-disabled or live-site message
- [ ] a misspelled site key is **refused** with a suggestion, not silently routed

### 6. Connect it in ClickUp

App Center (Workspace avatar > Apps, or the AI Command Bar's "Open App Center") >
**MCP Servers** > **Add Custom MCP Server**.

- [ ] **Workspace** tab, not Personal. Personal means only you get it. Needs owner or admin.
- [ ] Name: `WP Gateway`
- [ ] URL: `https://<host>/mcp` (the `/mcp` matters)
- [ ] Auth: **API key**. Header `Authorization`, value `Bearer <GATEWAY_TOKEN>`.
      The gateway also accepts a bare token in `X-API-Key` or `X-Gateway-Token` if
      ClickUp's field handling fights you on the `Bearer ` prefix.
- [ ] Confirm the four tools appear under the app's **AI Tools** section
- [ ] Ask Brain to list the WordPress sites, then ask about each one in turn
- [ ] Disconnect the old per-site Novamira connections. They are now redundant, and leaving
      them connected reintroduces the exact tool-name collision this gateway exists to fix.

**One connection, one token.** You cannot connect the full token and the read-only token
as two ClickUp connections to the same gateway: same four tool names, same flat namespace,
same collision. So connect **one** Workspace connection with `GATEWAY_TOKEN`, and treat the
per-site `writes` flag as the real guardrail, because it is. `GATEWAY_TOKEN_READONLY` is
there for a second client (Claude Desktop, a script, another workspace), not a second
ClickUp connection.

## What this looks like for everyone else

Nothing. That is the point.

A Workspace connection means the four tools are already in Brain for every member. Nobody
installs anything, nobody holds a token, nobody learns a site key. They ask in plain
language and Brain calls `wp_list_sites` to resolve it:

- "What plugins are running on the StrengthenND site?"
- "Is there an SEO redirect for /old-pricing on the Indak site?"
- "Which pages on Lund Oil are missing a meta description?"

Reads work everywhere, always. Writes are refused unless someone has deliberately flipped
`writes: true` for that site, and the refusal is a plain sentence the asker can act on
("Writes are disabled for Lund Oil, so that was not run"), not an error trace.

**The one habit worth enforcing:** flipping `writes: true` is a deliberate act, announced in
the channel, and flipped back when the build ships. Everything else in here is automatic.
If you skip that habit, you have handed the whole team root on every client site, which is
the failure mode this design is built to avoid.

Who needs what:

| Person | Needs | Can do |
|---|---|---|
| Everyone at Indak | nothing | Read any registered site through Brain |
| Whoever is building | writes flipped on for that site, on staging | Everything Novamira can do |
| You | host access to edit `REGISTRY_JSON` and secrets | Add sites, flip writes, read the audit log |

## Adding sites 3 through 14

Two things per site: a registry entry and one secret. No ClickUp changes, no reconnecting,
no new tools, no code edit.

```bash
npm run add-site lundoil "Lund Oil (staging)" https://staging.lundoil.com staging
```

That prints the exact registry entry and the env var name to set. Then:

1. **On the WordPress site:** Novamira active with **Enable AI Abilities** checked, a
   dedicated `novamira-bot` admin user, an Application Password generated for it. Grab the
   MCP endpoint path from Novamira > Configuration if it is not the default.
2. **On the host:** paste the entry into `REGISTRY_JSON` and set `WP_PW_LUNDOIL` to that
   application password.
3. **Restart** and check the boot log lists the new key. A site with no `base` or a missing
   secret is skipped with the reason printed, so the boot log is your config check.
4. **Verify** the new site *and* an existing one both answer in the same Brain conversation.
   That is the whole premise; test it every time.
5. Leave `writes: false` until a build actually starts.

Site key convention: lowercase of the client's ClickUp Space abbreviation, so the key people
say out loud matches where the work is tracked. Keep `-staging` in the **label**, not just
the key, so it shows up in Brain's output and nobody confuses live Lund Oil with a sandbox.

To take a site offline without losing its config, set `"disabled": true` on its entry.

## Layout

```
src/server.js     MCP protocol, auth, rate limit, audit log, tool surface
src/upstream.js   MCP client for one Novamira install (Basic auth, SSE + JSON parsing)
src/registry.js   registry.json loader and validator
src/guard.js      read/write classification and the root-ability list
scripts/selftest.js  offline end-to-end test with two fake WordPress installs
scripts/smoke.sh     verify a deployed gateway
scripts/newsite.js   print the registry entry + secret name for a new site
```

Upstream tool names are **discovered** at runtime via `tools/list` and matched by suffix,
so a Novamira rename does not break the gateway. Pin them per site with `upstreamTools`
in `registry.json` if you ever need to.

## Registry reference

| Key | Required | Default | Notes |
|---|---|---|---|
| `label` | no | site key | Shown to Brain. Put `(staging)` here. |
| `base` | **yes** | | Origin only. Must be https. Site is skipped without it. |
| `env` | **yes** | | `live` or `staging`. Drives the root block. |
| `user` | no | `novamira-bot` | WordPress user the app password belongs to. |
| `appPasswordEnv` | no | `WP_PW_<KEY>` | Name of the env var holding the app password. |
| `writes` | no | `false` | Must be explicitly `true` to allow mutations. |
| `mcpPath` | no | `/wp-json/mcp-adapter/mcp` | From Novamira > Configuration. |
| `rateLimitPerMin` | no | `30` | Per-site token bucket. |
| `timeoutMs` | no | `120000` | `execute-php` on a slow host needs room. |
| `disabled` | no | `false` | Keep a site in the file without loading it. |
| `upstreamTools` | no | auto | `{"discover":"...","info":"...","execute":"..."}` to pin names. |

## Notes

- The gateway is stateless: no `Mcp-Session-Id`, any replica serves any request, so it
  scales and redeploys without sticky sessions.
- Upstream WordPress sessions are cached per site and retried once if they go stale.
- Everything the gateway writes to stdout is one JSON object per line. Ship it somewhere
  before you need it: when a client site breaks at 11pm you will want this.
