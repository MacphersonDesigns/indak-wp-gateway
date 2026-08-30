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

1. **Per-site `writes` flag.** Staging sites ship with `writes: true` so the team can
   actually work. Live sites ship with `writes: false` and are read-only until someone
   deliberately changes that.
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

Leave `ALLOW_LIVE_ROOT` unset. Staging sites can have `writes: true`; leave live sites at
`writes: false`.

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

### 4b. If the domain does not answer at all

A green build with a dead process is the normal Hostinger failure. Open the domain root in
a browser first: a healthy gateway serves a plain-text `Indak WP Gateway is running` page
there. If you get that, the process is alive and any remaining problem is ClickUp-side.

If the root gives you nothing, a Hostinger placeholder, or a 503, check **Runtime Logs**
(not the build log) in that order:

1. **`=== GATEWAY DID NOT START ===`** in the log. The only fatal misconfiguration is a
   missing or too-short `GATEWAY_TOKEN`, because serving an unauthenticated gateway would
   be worse than serving nothing. The message names the problem.
   A **missing registry is not fatal**: the gateway boots anyway and the domain root tells
   you which env var to add. If you get that page, the hosting is fine and it is just config.
2. **Entry file** must be `src/server.js`. If it is blank or wrong, nothing ever launches.
3. **`PORT` must not be set by you.** Hostinger assigns it. If you set it, Hostinger cannot
   route to the app and you get a 503 forever.
4. **Build command must be empty.** There are no dependencies and nothing to build; a
   `npm run build` that does not exist fails the deploy.
5. **The domain slot.** If that domain already existed as a website in hPanel, the Web App
   flow will not have taken it over. Remove the old website or deploy to a fresh subdomain.
6. **Cold start.** The process stops when idle, so the very first request after a quiet
   spell can take a few seconds. Try twice before concluding it is down.

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

## What this looks like for the team

Nothing to install, nothing to configure, no token to hold, no site key to memorize.

One **Workspace** connection puts the four tools in Brain for every member, in the browser
app and in Brain MAX on desktop and mobile. (Note: MCP connections can only be *created*
from the ClickUp browser app. Set it up there once; it works everywhere after that.)
They ask in plain language and Brain calls `wp_list_sites` to resolve the site itself:

- "What plugins are running on the StrengthenND site?"
- "Is there a redirect for /old-pricing on the Indak site?"
- "Which Lund Oil pages are missing a meta description?"
- "Add a 301 from /party-bus to /party-bus-rentals on the Mysticon staging site."

**The default posture, so nobody has to ask permission for normal work:**

| | Reads | Writes | PHP / file writes / WP-CLI |
|---|---|---|---|
| Staging sites | anyone | anyone | anyone |
| Live sites | anyone | refused | refused |

That is deliberate. Staging is disposable, so the team can build there without waiting on
you, which is the productivity part. Live client sites are read-only, and root-class
abilities are refused on live even if someone flips the writes flag, because Novamira's
`execute-php` on a live client site is the one mistake you cannot undo from a chat window.

When something is refused, Brain gets a plain sentence and passes it on ("Writes are
disabled for Hall RV, so that was not run") instead of an error trace or a silent retry.

Who needs what:

| Person | Needs | Can do |
|---|---|---|
| Everyone at Indak | nothing | Read any site, build freely on staging |
| You | host access to edit `REGISTRY_JSON` and secrets | Add sites, allow a live write, read the audit log |

### Paste this in the team channel once it is live

> The WordPress sites are now in Brain. Just ask: "what plugins are on the StrengthenND
> site", "which Lund Oil pages are missing meta descriptions", "add a redirect on Mysticon
> staging". You don't need to set anything up and you don't need to know a site key, Brain
> figures out which site you mean. Staging sites you can change freely. Live sites are
> read-only on purpose: if you need a change on a live site, ask me and I'll open it up for
> the duration of the build.

### Why not a Super Agent

You could add these four tools to a Super Agent, but don't. Brain-native tools mean every
member gets them with zero setup and no per-user credit burn, which is the whole point of
running this on an unlimited plan. A Super Agent adds a step and a bill for something Brain
already does.

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
5. `npm run add-site` sets `writes` for you: true for staging, false for live.

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
