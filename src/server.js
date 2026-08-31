'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadRegistry } = require('./registry');
const { upstreamFor, UpstreamError } = require('./upstream');
const { classify, isRootAbility } = require('./guard');
const { databaseConfigured, createDatabasePool } = require('./site-manager/Database');
const { parseMasterKey } = require('./site-manager/CredentialCipher');
const { SiteRepository } = require('./site-manager/SiteRepository');
const { mergeRegistries } = require('./site-manager/RegistryMerge');
const { PairingService } = require('./site-manager/PairingService');
const { version: VERSION } = require('../package.json');

const PROTOCOL_VERSION = '2025-06-18';
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_LIVE_ROOT = process.env.ALLOW_LIVE_ROOT === 'true';

const TOKEN = process.env.GATEWAY_TOKEN || '';
const TOKEN_RO = process.env.GATEWAY_TOKEN_READONLY || '';
const ADMIN_TOKEN = process.env.GATEWAY_ADMIN_TOKEN || '';
function fatal(msg) {
  console.error('\n=== GATEWAY DID NOT START ===');
  console.error(msg);
  console.error('=============================\n');
  process.exit(1);
}

if (!TOKEN) {
  fatal('GATEWAY_TOKEN env var is not set.\nGenerate one with: openssl rand -hex 32\nThen set it as an environment variable on your host and redeploy.');
}
if (TOKEN.length < 32) {
  fatal(`GATEWAY_TOKEN is only ${TOKEN.length} characters. Use at least 32: openssl rand -hex 32`);
}
if (TOKEN_RO && TOKEN_RO === TOKEN) {
  fatal('GATEWAY_TOKEN_READONLY must be a different value from GATEWAY_TOKEN.');
}

let REGISTRY = { sites: {}, skipped: [], file: 'not loaded' };
let CONFIG_ERROR = null;
let DATABASE_POOL = null;
let DATABASE_STATUS = { configured: databaseConfigured(), connected: false, problem: null };
let SITE_REPOSITORY = null;
let PAIRING_SERVICE = null;

// ---------------------------------------------------------------- audit log
function audit(row) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

/**
 * Build the runtime registry before opening the listening socket. Environment entries are
 * the known-working fallback during rollout; MySQL entries add paired sites and become
 * authoritative only when they describe the same endpoint.
 */
async function initializeRegistry() {
  let environmentRegistry = { sites: {}, skipped: [], file: 'not loaded' };
  let environmentError = null;
  try {
    environmentRegistry = loadRegistry();
  } catch (error) {
    environmentError = error.message;
  }

  let databaseRegistry = { sites: {}, skipped: [] };
  if (DATABASE_STATUS.configured) {
    try {
      const masterKey = parseMasterKey();
      DATABASE_POOL = createDatabasePool();
      SITE_REPOSITORY = new SiteRepository(DATABASE_POOL, masterKey);
      await SITE_REPOSITORY.ping();
      databaseRegistry = await SITE_REPOSITORY.listActiveSites();
      if (ADMIN_TOKEN.length >= 32) {
        PAIRING_SERVICE = new PairingService(SITE_REPOSITORY, masterKey, {
          allowInsecure: process.env.ALLOW_INSECURE_PAIRING === 'true',
          allowPrivate: process.env.ALLOW_PRIVATE_PAIRING === 'true',
        });
      }
      DATABASE_STATUS = { configured: true, connected: true, problem: null };
    } catch (error) {
      DATABASE_STATUS = { configured: true, connected: false, problem: error.message };
      if (DATABASE_POOL) await DATABASE_POOL.end().catch(() => {});
      DATABASE_POOL = null;
      SITE_REPOSITORY = null;
      PAIRING_SERVICE = null;
    }
  }

  const merged = mergeRegistries(environmentRegistry, databaseRegistry);
  REGISTRY = {
    sites: merged.sites,
    skipped: merged.skipped,
    file: DATABASE_STATUS.connected
      ? `${environmentRegistry.file} + Hostinger MySQL`
      : environmentRegistry.file,
  };

  if (!Object.keys(REGISTRY.sites).length) {
    const problems = [];
    if (environmentError) problems.push(environmentError);
    if (DATABASE_STATUS.configured && DATABASE_STATUS.problem) {
      problems.push(`Database registry unavailable: ${DATABASE_STATUS.problem}`);
    }
    CONFIG_ERROR = problems.join(' ') || 'The registry loaded but contains no usable sites.';
  } else {
    CONFIG_ERROR = null;
    if (DATABASE_STATUS.configured && DATABASE_STATUS.problem) {
      REGISTRY.skipped.push({ key: 'database', why: DATABASE_STATUS.problem });
    }
  }
}

// ------------------------------------------------------------- rate limiter
const buckets = new Map();
function rateLimited(siteKey, perMin) {
  const now = Date.now();
  const b = buckets.get(siteKey) || { tokens: perMin, last: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.last) / 60000) * perMin);
  b.last = now;
  if (b.tokens < 1) { buckets.set(siteKey, b); return true; }
  b.tokens -= 1;
  buckets.set(siteKey, b);
  return false;
}

// -------------------------------------------------------------------- auth
function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** @returns {null | { scope: 'full'|'read' }} */
function authenticate(req) {
  const raw =
    req.headers.authorization ||
    req.headers['x-api-key'] ||
    req.headers['x-gateway-token'] ||
    '';
  const presented = String(raw).replace(/^Bearer\s+/i, '').trim();
  if (!presented) return null;
  if (safeEq(presented, TOKEN)) return { scope: 'full' };
  if (TOKEN_RO && safeEq(presented, TOKEN_RO)) return { scope: 'read' };
  return null;
}

function authenticateAdmin(req) {
  if (ADMIN_TOKEN.length < 32) return false;
  const presented = String(req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return presented ? safeEq(presented, ADMIN_TOKEN) : false;
}

// Enrollment endpoints are intentionally much tighter than per-site MCP buckets. Pairing
// performs DNS and upstream work, so an unauthenticated flood must be rejected cheaply.
const enrollmentBuckets = new Map();
function enrollmentLimited(key, limit = 20) {
  const now = Date.now();
  const recent = (enrollmentBuckets.get(key) || []).filter((time) => now - time < 60000);
  recent.push(now);
  enrollmentBuckets.set(key, recent);
  return recent.length > limit;
}

// ------------------------------------------------------------- tool surface
const TOOLS = [
  {
    name: 'wp_list_sites',
    description:
      'List every Indak-managed WordPress site this gateway can reach. Returns the exact site key to pass to the other tools, plus each site\'s environment (live or staging) and whether writes are currently enabled. Call this first when the user names a site in prose ("the StrengthenND site") so you route to the right install.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wp_discover_abilities',
    description:
      'List the Novamira abilities available on one site, along with that site\'s WordPress version, active theme, and installed plugins. Start here before doing any work on a site.',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string', description: 'Site key from wp_list_sites.' } },
      required: ['site'],
      additionalProperties: false,
    },
  },
  {
    name: 'wp_get_ability_info',
    description:
      'Get the full input and output schema for one Novamira ability on one site. Call this before wp_execute_ability when you are unsure of an ability\'s parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site key from wp_list_sites.' },
        ability_name: { type: 'string', description: 'Full ability name, e.g. novamira/execute-php.' },
      },
      required: ['site', 'ability_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'wp_execute_ability',
    description:
      'Run one Novamira ability on one site. Write-class abilities are refused unless that site has writes enabled, and PHP execution, file writes, and WP-CLI are refused outright on live sites. Refusals come back as normal tool output: read the message and tell the user what needs to change rather than retrying.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site key from wp_list_sites.' },
        ability_name: { type: 'string', description: 'Full ability name, e.g. novamira/execute-php.' },
        parameters: { type: 'object', description: 'Arguments for the ability.', additionalProperties: true },
      },
      required: ['site', 'ability_name', 'parameters'],
      additionalProperties: false,
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const refuse = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/** Small Levenshtein so a near-miss key gets a suggestion, never a silent route. */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function resolveSite(key) {
  const sites = REGISTRY.sites;
  if (typeof key !== 'string' || !key.trim()) {
    return { error: `No site given. Call wp_list_sites for the valid keys: ${Object.keys(sites).join(', ')}.` };
  }
  const k = key.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (sites[k]) return { site: sites[k] };
  const keys = Object.keys(sites);
  const exact = keys.find((s) => s.replace(/[^a-z0-9]/g, '') === k);
  if (exact) return { site: sites[exact] };
  const near = keys.filter((s) => {
    const t = s.replace(/[^a-z0-9]/g, '');
    if (t.includes(k) || k.includes(t)) return true;
    return editDistance(t, k) <= Math.max(2, Math.round(Math.max(t.length, k.length) * 0.25));
  });
  return {
    error:
      `Unknown site "${key}". ` +
      (near.length ? `Did you mean ${near.join(' or ')}? ` : '') +
      `Valid keys: ${Object.keys(sites).join(', ')}. Call wp_list_sites to confirm.`,
  };
}

async function callTool(name, args, ctx) {
  args = args || {};

  if (CONFIG_ERROR) {
    audit({ event: 'deny', tool: name, caller: ctx.scope, reason: 'gateway not configured' });
    return refuse(
      `The WordPress gateway is running but has no site registry loaded, so no site can be ` +
      `reached yet. Tell Alex: "${CONFIG_ERROR}"`
    );
  }

  if (name === 'wp_list_sites') {
    const list = Object.values(REGISTRY.sites).map((s) => ({
      site: s.key,
      label: s.label,
      env: s.env,
      url: s.base,
      writes: s.writes,
      root_abilities_blocked: s.env === 'live' && !ALLOW_LIVE_ROOT,
    }));
    audit({ event: 'tool', tool: name, caller: ctx.scope, sites: list.length });
    return text({
      sites: list,
      note:
        'Pass "site" to the other tools. writes:false means read-only. ' +
        'root_abilities_blocked means PHP execution, file writes, and WP-CLI are refused on that site.',
    });
  }

  const { site, error } = resolveSite(args.site);
  if (error) {
    audit({ event: 'deny', tool: name, caller: ctx.scope, site: args.site ?? null, reason: 'unknown site' });
    return refuse(error);
  }

  if (rateLimited(site.key, site.rateLimitPerMin)) {
    audit({ event: 'deny', tool: name, caller: ctx.scope, site: site.key, reason: 'rate limit' });
    return refuse(`Rate limit hit for ${site.label} (${site.rateLimitPerMin}/min). Wait a moment before retrying.`);
  }

  const up = upstreamFor(site);
  const started = Date.now();

  try {
    if (name === 'wp_discover_abilities') {
      const r = await up.callWithRetry('discover', {});
      audit({ event: 'tool', tool: name, caller: ctx.scope, site: site.key, ms: Date.now() - started });
      return r ?? text('No response body from that site.');
    }

    if (name === 'wp_get_ability_info') {
      if (!args.ability_name) return refuse('ability_name is required.');
      const r = await up.callWithRetry('info', { ability_name: args.ability_name });
      audit({ event: 'tool', tool: name, caller: ctx.scope, site: site.key, ability: args.ability_name, ms: Date.now() - started });
      return r ?? text('No response body from that site.');
    }

    if (name === 'wp_execute_ability') {
      const ability = args.ability_name;
      if (!ability) return refuse('ability_name is required.');

      const { write, reason } = classify(ability);
      const root = isRootAbility(ability);

      if (ctx.scope === 'read' && write) {
        audit({ event: 'deny', tool: name, caller: ctx.scope, site: site.key, ability, reason: 'read-only token' });
        return refuse(
          `"${ability}" is a write-class ability (${reason}) and this connection is read-only. ` +
          `Ask an engineer at Indak to run it.`
        );
      }
      if (root && site.env === 'live' && !ALLOW_LIVE_ROOT) {
        audit({ event: 'deny', tool: name, caller: ctx.scope, site: site.key, ability, reason: 'live root block' });
        return refuse(
          `"${ability}" runs arbitrary code and ${site.label} is a LIVE site, so the gateway refuses it. ` +
          `Do this on staging. If it genuinely has to happen on live, a human must set ALLOW_LIVE_ROOT=true on the gateway and say so in the channel.`
        );
      }
      if (write && !site.writes) {
        audit({ event: 'deny', tool: name, caller: ctx.scope, site: site.key, ability, reason: 'writes disabled' });
        return refuse(
          `Writes are disabled for ${site.label}, so "${ability}" was not run (${reason}). ` +
          `Reads still work. To change this, flip "writes": true for "${site.key}" in the gateway registry, ` +
          `and turn it back off when the build ships.`
        );
      }

      const r = await up.callWithRetry('execute', {
        ability_name: ability,
        parameters: args.parameters || {},
      });
      audit({ event: 'tool', tool: name, caller: ctx.scope, site: site.key, ability, write, ms: Date.now() - started });
      return r ?? text('No response body from that site.');
    }

    return refuse(`Unknown tool "${name}".`);
  } catch (e) {
    const msg = e instanceof UpstreamError ? e.message : `Unexpected gateway error: ${e.message}`;
    audit({ event: 'error', tool: name, caller: ctx.scope, site: site.key, ability: args.ability_name ?? null, ms: Date.now() - started, error: msg });
    return refuse(msg);
  }
}

// ---------------------------------------------------------- JSON-RPC / MCP
async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'indak-wp-gateway', version: VERSION },
        instructions:
          'One endpoint fronting every Indak-managed WordPress site running Novamira. ' +
          'Call wp_list_sites first to turn a site name into a key, then pass that key to the other tools.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool "${name}".`);
      const result = await callTool(name, params?.arguments, ctx);
      return reply(result);
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (String(method || '').startsWith('notifications/')) return null;
      return fail(-32601, `Method "${method}" is not supported by this gateway.`);
  }
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const adminAssets = {
    '/admin': ['index.html', 'text/html; charset=utf-8'],
    '/admin/': ['index.html', 'text/html; charset=utf-8'],
    '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'],
    '/admin/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  };
  if (req.method === 'GET' && adminAssets[url.pathname]) {
    const [file, contentType] = adminAssets[url.pathname];
    const body = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', file));
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    return res.end(body);
  }

  if (url.pathname === '/healthz' || url.pathname === '/health') {
    const database = DATABASE_STATUS.configured
      ? DATABASE_STATUS.connected ? 'connected' : 'degraded'
      : 'not-configured';
    if (CONFIG_ERROR) return json(res, 503, { ok: false, sites: 0, database, problem: CONFIG_ERROR });
    return json(res, 200, { ok: true, sites: Object.keys(REGISTRY.sites).length, database });
  }

  if (url.pathname === '/admin/sites' || url.pathname === '/admin/pairing-codes') {
    if (!authenticateAdmin(req)) {
      audit({ event: 'admin_auth_fail', ip: req.socket.remoteAddress, path: url.pathname });
      res.setHeader('www-authenticate', 'Bearer');
      return json(res, 401, { error: 'Unauthorized.' });
    }
    if (!SITE_REPOSITORY || !PAIRING_SERVICE) {
      return json(res, 503, { error: 'Site Manager is unavailable. Check database and admin-token configuration.' });
    }
    if (enrollmentLimited(`admin:${req.socket.remoteAddress}`, 60)) {
      return json(res, 429, { error: 'Site Manager rate limit exceeded. Try again shortly.' });
    }
    if (url.pathname === '/admin/sites' && req.method === 'GET') {
      try {
        return json(res, 200, { sites: await SITE_REPOSITORY.listSitesForAdmin() });
      } catch (error) {
        audit({ event: 'admin_error', action: 'list_sites', error: error.message });
        return json(res, 500, { error: 'Could not load registered sites.' });
      }
    }
    if (url.pathname === '/admin/pairing-codes' && req.method === 'POST') {
      try {
        const input = JSON.parse(await readBody(req, 64 * 1024));
        const result = await PAIRING_SERVICE.createPairing(input, ADMIN_TOKEN);
        audit({ event: 'pairing_code_created', site: result.site_key });
        return json(res, 201, result);
      } catch (error) {
        audit({ event: 'admin_error', action: 'create_pairing', error: error.message });
        return json(res, 400, { error: error.message });
      }
    }
    return json(res, 405, { error: 'Method not allowed.' });
  }

  if (url.pathname === '/pairings/details' || url.pathname === '/pairings/claim') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    if (!PAIRING_SERVICE) return json(res, 503, { error: 'Pairing is temporarily unavailable.' });
    if (enrollmentLimited(`claim:${req.socket.remoteAddress}`, 10)) {
      return json(res, 429, { error: 'Pairing rate limit exceeded. Create a new code and try again later.' });
    }
    try {
      const input = JSON.parse(await readBody(req, 64 * 1024));
      if (url.pathname === '/pairings/details') {
        return json(res, 200, await PAIRING_SERVICE.pairingDetails(input));
      }
      const paired = await PAIRING_SERVICE.claimPairing(input);
      REGISTRY.sites[paired.runtimeSite.key] = paired.runtimeSite;
      audit({ event: 'site_paired', site: paired.result.site_key, env: paired.result.environment });
      return json(res, 201, paired.result);
    } catch (error) {
      audit({ event: 'pairing_failed', ip: req.socket.remoteAddress, error: error.message });
      return json(res, 400, { error: error.message });
    }
  }

  // Proof of life you can check in a browser, and a checklist when it is unhappy.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let body;
    if (CONFIG_ERROR) {
      body =
        `Indak WP Gateway is RUNNING but NOT CONFIGURED.\n\n` +
        `Problem: ${CONFIG_ERROR}\n\n` +
        `FIX: add ONE environment variable named SITES, then redeploy.\n` +
        `No quotes, no braces, nothing for a hosting panel to mangle.\n\n` +
        `  SITES = mysticon | Mysticon | https://mysticonnd.com | live\n\n` +
        `Format is:  key | Label | https://url | live or staging\n` +
        `One site per line. Add more lines for more sites.\n\n` +
        `Then one password variable per site, named WP_PW_ plus the key in caps:\n\n` +
        `  WP_PW_MYSTICON = that site's WordPress application password for novamira-bot\n\n` +
        `Every ability call is refused until this loads.\n`;
    } else {
      const skipped = REGISTRY.skipped.length;
      body =
        `Indak WP Gateway is running.\n\n` +
        `MCP endpoint : POST ${MCP_PATH}  (needs Authorization: Bearer <GATEWAY_TOKEN>)\n` +
        `Health       : GET /healthz\n` +
        `Sites loaded : ${Object.keys(REGISTRY.sites).length}\n` +
        (skipped
          ? `Sites skipped: ${skipped}\n` +
            REGISTRY.skipped.map((x) => `  - ${x.key}: ${x.why}\n`).join('')
          : '') +
        `\nThis page is public on purpose and lists no site names, URLs or secrets.\n`;
    }
    res.writeHead(CONFIG_ERROR ? 503 : 200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(body);
  }

  if (url.pathname !== MCP_PATH) {
    return json(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
  }

  const ctx = authenticate(req);
  if (!ctx) {
    audit({ event: 'auth_fail', ip: req.socket.remoteAddress, method: req.method });
    res.setHeader('www-authenticate', 'Bearer');
    return json(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized.' } });
  }

  if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET') {
    return json(res, 405, {
      jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'This gateway is stateless and does not open server-initiated streams. POST JSON-RPC here.' },
    });
  }
  if (req.method !== 'POST') {
    return json(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST.' } });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${e.message}` } });
  }

  try {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(m, ctx)))).filter(Boolean);
      if (!out.length) { res.writeHead(202); return res.end(); }
      return json(res, 200, out);
    }
    const out = await handleRpc(body, ctx);
    if (!out) { res.writeHead(202); return res.end(); }
    return json(res, 200, out);
  } catch (e) {
    audit({ event: 'error', error: e.message, stack: e.stack });
    return json(res, 500, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: 'Internal gateway error.' } });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65000;

async function start() {
  await initializeRegistry();
  server.listen(PORT, HOST, () => {
    audit({
      event: 'boot',
      endpoint: `${MCP_PATH}`,
      port: PORT,
      registry: REGISTRY.file,
      config_error: CONFIG_ERROR,
      database: DATABASE_STATUS,
      sites: Object.values(REGISTRY.sites).map((s) => `${s.key} (${s.env}, writes=${s.writes})`),
      skipped: REGISTRY.skipped,
      allow_live_root: ALLOW_LIVE_ROOT,
      readonly_token: Boolean(TOKEN_RO),
    });
    if (CONFIG_ERROR) {
      console.error('\n=== GATEWAY IS RUNNING BUT NOT CONFIGURED ===');
      console.error(CONFIG_ERROR);
      console.error('Open the domain root in a browser for the fix. Tool calls are refused until then.');
      console.error('============================================\n');
    } else if (!Object.keys(REGISTRY.sites).length) {
      console.error('WARNING: the registry loaded but contains no usable sites. Every tool call will fail.');
    }
    if (ALLOW_LIVE_ROOT) {
      console.error('WARNING: ALLOW_LIVE_ROOT=true. PHP execution and file writes are permitted on LIVE client sites.');
    }
  });
}

start().catch((error) => {
  // Only token validation may hard-exit. Unexpected startup failures remain visible instead
  // of becoming a silent dead Hostinger domain.
  CONFIG_ERROR = `Unexpected startup failure: ${error.message}`;
  REGISTRY = { sites: {}, skipped: [], file: 'startup failed' };
  server.listen(PORT, HOST, () => audit({ event: 'boot_error', port: PORT, error: CONFIG_ERROR }));
});

module.exports = { server, TOOLS, callTool, handleRpc, initializeRegistry };
