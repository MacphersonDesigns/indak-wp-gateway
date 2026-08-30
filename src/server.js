'use strict';

const http = require('http');
const crypto = require('crypto');
const { loadRegistry } = require('./registry');
const { upstreamFor, UpstreamError } = require('./upstream');
const { classify, isRootAbility } = require('./guard');

const PROTOCOL_VERSION = '2025-06-18';
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_LIVE_ROOT = process.env.ALLOW_LIVE_ROOT === 'true';

const TOKEN = process.env.GATEWAY_TOKEN || '';
const TOKEN_RO = process.env.GATEWAY_TOKEN_READONLY || '';
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

let REGISTRY;
try {
  REGISTRY = loadRegistry();
} catch (e) {
  fatal(e.message);
}

// ---------------------------------------------------------------- audit log
function audit(row) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
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
        serverInfo: { name: 'indak-wp-gateway', version: '1.0.0' },
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

  if (url.pathname === '/healthz' || url.pathname === '/health') {
    return json(res, 200, { ok: true, sites: Object.keys(REGISTRY.sites).length });
  }

  // Proof of life you can check in a browser. If you see this, the process is
  // running and the config loaded; anything still broken is ClickUp-side.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const body =
      `Indak WP Gateway is running.\n\n` +
      `MCP endpoint : POST ${MCP_PATH}  (needs Authorization: Bearer <GATEWAY_TOKEN>)\n` +
      `Health       : GET /healthz\n` +
      `Sites loaded : ${Object.keys(REGISTRY.sites).length}` +
      (REGISTRY.skipped.length ? `\nSites skipped: ${REGISTRY.skipped.length} (see the boot log for why)` : '') +
      `\n\nThis page is public on purpose and lists no site names, URLs or secrets.\n`;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
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

server.listen(PORT, HOST, () => {
  audit({
    event: 'boot',
    endpoint: `${MCP_PATH}`,
    port: PORT,
    registry: REGISTRY.file,
    sites: Object.values(REGISTRY.sites).map((s) => `${s.key} (${s.env}, writes=${s.writes})`),
    skipped: REGISTRY.skipped,
    allow_live_root: ALLOW_LIVE_ROOT,
    readonly_token: Boolean(TOKEN_RO),
  });
  if (!Object.keys(REGISTRY.sites).length) {
    console.error('WARNING: no usable sites in the registry. Every tool call will fail.');
  }
  if (ALLOW_LIVE_ROOT) {
    console.error('WARNING: ALLOW_LIVE_ROOT=true. PHP execution and file writes are permitted on LIVE client sites.');
  }
});

module.exports = { server, TOOLS, callTool, handleRpc };
