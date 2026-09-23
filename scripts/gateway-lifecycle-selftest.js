#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of the running gateway's HTTP surface against a real MySQL/MariaDB
 * (npm run db:up && npm run db:migrate) and a fake Novamira that behaves like MCP Adapter
 * 0.6.1. Walks the full site lifecycle the way the team uses it: pair, call tools, survive an
 * expired session, see a broken site in the Site Manager, re-pair in place, disconnect from
 * WordPress, re-pair, and remove from the Site Manager.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createDatabasePool } = require('../src/site-manager/Database');
const { SiteRepository } = require('../src/site-manager/SiteRepository');
const { managementToken } = require('../src/site-manager/ConnectorAuth');

function fakeNovamira(accepted) {
  const sessions = new Set();
  const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!accepted.has(presented)) {
      return send(401, { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.', data: { status: 401 } });
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw || '{}');
      const rpc = (result, headers) => send(200, { jsonrpc: '2.0', id: message.id, result }, headers);
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (message.method === 'initialize') {
        const id = crypto.randomUUID();
        sessions.add(id);
        return rpc({ protocolVersion: '2025-06-18', capabilities: {} }, { 'mcp-session-id': id });
      }
      if (!sessions.has(req.headers['mcp-session-id'])) {
        return send(404, { jsonrpc: '2.0', id: message.id, error: { code: -32005, message: 'Session not found: Invalid or expired session' } });
      }
      if (message.method === 'tools/list') {
        return rpc({ tools: ['discover-abilities', 'get-ability-info', 'execute-ability'].map((n) => ({ name: `mcp-adapter-${n}` })) });
      }
      return rpc({ content: [{ type: 'text', text: `FAKE-NOVAMIRA answered ${message.params?.name}` }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, sessions, port: server.address().port }));
  });
}

(async () => {
  let passed = 0;
  const check = (message, fn) => {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const accepted = new Set();
  const wordpress = await fakeNovamira(accepted);
  const home = `http://127.0.0.1:${wordpress.port}`;
  const siteKey = `lifecycle-${crypto.randomBytes(3).toString('hex')}`;
  const TOKEN = 'e'.repeat(64);
  const ADMIN = 'f'.repeat(64);
  const KEY = '33'.repeat(32);
  const PORT = 41972;
  const base = `http://127.0.0.1:${PORT}`;

  const gateway = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1', GATEWAY_TOKEN: TOKEN, GATEWAY_ADMIN_TOKEN: ADMIN,
      REGISTRY_ENCRYPTION_KEY: KEY, REGISTRY_FILE: '/nonexistent/registry.json', SITES: '',
      ALLOW_INSECURE_PAIRING: 'true', ALLOW_PRIVATE_PAIRING: 'true',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let log = '';
  gateway.stdout.on('data', (chunk) => { log += chunk.toString(); });
  for (let i = 0; i < 50 && !log.includes('"event":"boot"'); i++) await sleep(100);

  const request = async (method, route, body, token) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const tool = async (name, args = {}) => {
    const { body } = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, TOKEN);
    return body.result.content[0].text;
  };
  const pair = async () => {
    const credential = crypto.randomBytes(32).toString('base64url');
    accepted.add(credential);
    const code = await request('POST', '/admin/pairing-codes', {
      mcp_url: home, site_key: siteKey, label: 'Lifecycle test (staging)', environment: 'staging', writes: true,
    }, ADMIN);
    const details = await request('POST', '/pairings/details', { code: code.body.code, home_url: home });
    const claim = await request('POST', '/pairings/claim', {
      code: code.body.code, home_url: home, mcp_url: details.body.mcp_url, credential, connector_version: '0.2.0',
    });
    return { code, claim, credential };
  };
  const adminSite = async () => (await request('GET', '/admin/sites', null, ADMIN)).body.sites.find((s) => s.site_key === siteKey);

  const pool = createDatabasePool();
  const repository = new SiteRepository(pool, Buffer.from(KEY, 'hex'));
  try {
    console.log('\n== pairing through the HTTP API');
    const unauthorized = await request('GET', '/admin/sites');
    check('the Site Manager rejects a missing admin token', () => assert.strictEqual(unauthorized.status, 401));
    const first = await pair();
    check('a pairing code is issued for a bare site URL', () => assert.strictEqual(first.code.status, 201));
    check('the claim activates the site', () => {
      assert.strictEqual(first.claim.status, 201, JSON.stringify(first.claim.body));
      assert.strictEqual(first.claim.body.replaced, false);
    });

    console.log('\n== routing, as ClickUp Brain sees it');
    const listed = await tool('wp_list_sites');
    check('the paired site is routable immediately, without a restart', () => assert(listed.includes(siteKey)));
    const discovered = await tool('wp_discover_abilities', { site: siteKey });
    check('tool calls reach the paired site', () => assert.match(discovered, /FAKE-NOVAMIRA/));

    wordpress.sessions.clear();
    const afterExpiry = await tool('wp_discover_abilities', { site: siteKey });
    check('an expired Novamira session recovers on the next call', () => assert.match(afterExpiry, /FAKE-NOVAMIRA/));

    const token = managementToken(first.credential);
    const status = await request('POST', '/connector/status', { site_key: siteKey, home_url: home, verify: true }, token);
    check('WordPress can confirm its connection with the management token', () => {
      assert.strictEqual(status.status, 200);
      assert.deepStrictEqual(status.body.check, { ok: true });
    });
    const wrong = await request('POST', '/connector/status', { site_key: siteKey, home_url: home }, 'x'.repeat(64));
    check('a wrong management token is refused', () => assert.strictEqual(wrong.status, 404));
    for (let i = 0; i < 35; i++) {
      await request('POST', '/connector/status', { site_key: 'someone-else', home_url: home }, 'x'.repeat(64));
    }
    const stillServed = await request('POST', '/connector/status', { site_key: siteKey, home_url: home }, token);
    check('junk traffic for other keys cannot use up a real site\'s budget', () => assert.strictEqual(stillServed.status, 200));
    let throttled = 0;
    for (let i = 0; i < 35; i++) {
      const junk = await request('POST', '/connector/status', { site_key: siteKey, home_url: home }, 'y'.repeat(64));
      if (junk.status === 429) throttled++;
    }
    const realConnector = await request('POST', '/connector/status', { site_key: siteKey, home_url: home }, token);
    check('failed guesses at a real key are throttled but never block its own connector', () => {
      assert(throttled > 0, 'guesses were never throttled');
      assert.strictEqual(realConnector.status, 200);
    });

    console.log('\n== a broken site is visible, and re-pairing fixes it in place');
    accepted.delete(first.credential);
    const rejected = await tool('wp_discover_abilities', { site: siteKey });
    check('a rejected credential explains how to fix it', () => assert.match(rejected, /re-pair/i));
    await sleep(300);
    const broken = await adminSite();
    check('the Site Manager shows the failure without anyone running a test', () => {
      assert.match(broken.last_error || '', /rejected the gateway credential/);
    });

    const second = await pair();
    check('re-pairing the same site replaces the old record (no database edits)', () => {
      assert.strictEqual(second.claim.status, 201, JSON.stringify(second.claim.body));
      assert.strictEqual(second.claim.body.replaced, true);
      assert.deepStrictEqual(second.code.body.replaces, { site_key: siteKey, label: 'Lifecycle test (staging)' });
    });
    const repaired = await tool('wp_discover_abilities', { site: siteKey });
    check('calls work again with the new credential', () => assert.match(repaired, /FAKE-NOVAMIRA/));
    const healed = await adminSite();
    check('the error clears after a successful re-pair', () => assert.strictEqual(healed.last_error, null));

    console.log('\n== disconnect from WordPress actually removes the site');
    const disconnect = await request('POST', '/connector/disconnect', { site_key: siteKey, home_url: home }, managementToken(second.credential));
    check('the gateway accepts the disconnect', () => assert.strictEqual(disconnect.status, 200));
    const afterDisconnect = await tool('wp_list_sites');
    check('the site stops being routable at once', () => assert(!afterDisconnect.includes(siteKey)));
    const removedRow = await adminSite();
    check('the Site Manager shows it as removed', () => assert.strictEqual(removedRow.status, 'disabled'));

    const third = await pair();
    const afterRepair = await tool('wp_list_sites');
    check('the site can be paired again right away', () => {
      assert.strictEqual(third.claim.status, 201);
      assert(afterRepair.includes(siteKey));
    });

    console.log('\n== Site Manager test and remove');
    const tested = await request('POST', `/admin/sites/${siteKey}/verify`, null, ADMIN);
    check('Test runs a live round trip', () => assert.deepStrictEqual(tested.body, { ok: true, site_key: siteKey }));
    const removed = await request('DELETE', `/admin/sites/${siteKey}`, null, ADMIN);
    const afterRemove = await tool('wp_list_sites');
    check('Remove disables the site', () => {
      assert.strictEqual(removed.status, 200);
      assert(!afterRemove.includes(siteKey));
    });
    const testRemoved = await request('POST', `/admin/sites/${siteKey}/verify`, null, ADMIN);
    check('a removed site cannot be tested', () => assert.strictEqual(testRemoved.status, 404));

    const health = await request('GET', '/healthz');
    check('health reports the database as connected', () => assert.strictEqual(health.body.database, 'connected'));
  } finally {
    gateway.kill();
    const rows = await repository.listSitesForAdmin().catch(() => []);
    for (const row of rows.filter((site) => site.site_key === siteKey)) {
      await repository.deleteSiteForTest(row.id).catch(() => {});
    }
    await repository.deletePairingsForTest(siteKey).catch(() => {});
    await pool.end();
    wordpress.server.close();
  }
  console.log(`\n${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(`Gateway lifecycle self-test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
