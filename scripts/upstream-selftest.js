#!/usr/bin/env node
'use strict';

/**
 * Upstream recovery checks against a fake Novamira that answers the way WordPress MCP Adapter
 * 0.6.1 does (the version Novamira bundles):
 *   - sessions are created only by initialize without an Mcp-Session-Id header
 *   - an unknown or expired session: HTTP 404, JSON-RPC -32005
 *   - a missing session header: HTTP 400, JSON-RPC -32600
 *   - an unknown tool: HTTP 404, JSON-RPC -32003
 *   - a missing route: HTTP 404, WordPress rest_no_route
 * No network or database needed:  npm run selftest:upstream
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { Upstream, UpstreamError } = require('../src/upstream');

function fakeNovamira(credential) {
  const state = {
    sessions: new Set(),
    prefix: 'mcp-adapter',
    routeMissing: false,
    legacyExpiry: false,
    initializeCount: 0,
    expiredResponses: 0,
    notifyDelayMs: 0,
    responseDelayMs: 0,
    stallBody: false,
  };
  const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (state.routeMissing) {
      return send(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } });
    }
    if (req.headers.authorization !== `Bearer ${credential}`) {
      return send(401, { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.', data: { status: 401 } });
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw || '{}');
      Object.defineProperty(message, '__session', { value: req.headers['mcp-session-id'] });
      if (message.id === undefined) {
        return setTimeout(() => { res.writeHead(202); res.end(); }, state.notifyDelayMs);
      }
      if (state.stallBody && message.method === 'tools/call') {
        // Headers, then silence: the body never finishes.
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.write('{"jsonrpc":"2.0",');
      }
      if (state.responseDelayMs) {
        const delay = state.responseDelayMs;
        state.responseDelayMs = 0;
        return setTimeout(() => handle(message), delay);
      }
      return handle(message);
    });
    function handle(message) {
      const rpc = (result) => send(200, { jsonrpc: '2.0', id: message.id, result });
      const rpcError = (status, code, text) => send(status, { jsonrpc: '2.0', id: message.id, error: { code, message: text } });
      const session = message.__session;
      if (message.method === 'initialize') {
        state.initializeCount++;
        if (session) return rpc({ protocolVersion: '2025-06-18', capabilities: {} });
        const id = crypto.randomUUID();
        state.sessions.add(id);
        res.setHeader('mcp-session-id', id);
        return rpc({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-novamira' } });
      }
      if (!session) return rpcError(400, -32600, 'Invalid Request: Missing Mcp-Session-Id header');
      if (!state.sessions.has(session)) {
        state.expiredResponses++;
        return state.legacyExpiry
          ? rpcError(200, -32602, 'Invalid params: Invalid or expired session')
          : rpcError(404, -32005, 'Session not found: Invalid or expired session');
      }
      const names = ['discover-abilities', 'get-ability-info', 'execute-ability'].map((n) => `${state.prefix}-${n}`);
      if (message.method === 'tools/list') return rpc({ tools: names.map((name) => ({ name })) });
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        if (!names.includes(name)) return rpcError(404, -32003, `Tool not found: ${name}`);
        if (typeof message.params.arguments !== 'object') {
          return rpcError(200, -32602, 'Invalid params: arguments must be an object');
        }
        if (name.endsWith('execute-ability') && message.params.arguments.ability_name === 'novamira/missing') {
          return rpc({ content: [{ type: 'text', text: "Ability 'novamira/missing' not found" }], isError: true });
        }
        return rpc({ content: [{ type: 'text', text: `ok from ${name}` }] });
      }
      return rpcError(404, -32601, `Method not found: ${message.method}`);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

(async () => {
  let passed = 0;
  const check = (message, fn) => {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
  };
  const expectError = async (promise, kind) => {
    try {
      await promise;
    } catch (error) {
      assert(error instanceof UpstreamError, `expected UpstreamError, got ${error}`);
      assert.strictEqual(error.kind, kind, `expected kind ${kind}, got ${error.kind}: ${error.message}`);
      return error;
    }
    throw new Error(`expected a ${kind} error`);
  };

  const credential = crypto.randomBytes(32).toString('base64url');
  const fake = await fakeNovamira(credential);
  const site = {
    key: 'fake', label: 'Fake Novamira', base: `http://127.0.0.1:${fake.port}`,
    mcpPath: '/wp-json/mcp/novamira', authType: 'scoped-bearer', password: credential, timeoutMs: 5000,
  };
  let rediscovered = null;
  const up = new Upstream(site, { onToolsChanged: (map) => { rediscovered = map; } });

  try {
    console.log('\n== sessions');
    const first = await up.callWithRetry('discover', {});
    check('first call initializes one session', () => {
      assert.match(first.content[0].text, /ok from mcp-adapter-discover-abilities/);
      assert.strictEqual(fake.state.initializeCount, 1);
    });

    fake.state.sessions.clear();
    const afterExpiry = await up.callWithRetry('discover', {});
    check('an expired session (404 / -32005) is replaced transparently', () => {
      assert.match(afterExpiry.content[0].text, /ok/);
      assert.strictEqual(fake.state.expiredResponses, 1);
      assert.strictEqual(fake.state.initializeCount, 2);
    });

    fake.state.sessions.clear();
    fake.state.legacyExpiry = true;
    await up.callWithRetry('discover', {});
    check('older adapters (200 / -32602 "Invalid or expired session") also recover', () => {
      assert.strictEqual(fake.state.initializeCount, 3);
    });
    fake.state.legacyExpiry = false;

    const expiredBefore = fake.state.expiredResponses;
    up.lastUsedAt = Date.now() - 4 * 60 * 60 * 1000;
    await up.callWithRetry('discover', {});
    check('an idle session is renewed before Novamira would reject it', () => {
      assert.strictEqual(fake.state.expiredResponses, expiredBefore);
      assert.strictEqual(fake.state.initializeCount, 4);
    });

    console.log('\n== tool names');
    fake.state.prefix = 'novamira-v2';
    const renamed = await up.callWithRetry('execute', { ability_name: 'novamira/read-file', parameters: {} });
    check('a renamed adapter tool (404 / -32003) is rediscovered and retried', () => {
      assert.match(renamed.content[0].text, /ok from novamira-v2-execute-ability/);
      assert.strictEqual(rediscovered.execute, 'novamira-v2-execute-ability');
    });

    fake.state.prefix = 'novamira-v3';
    const renameRace = await Promise.allSettled([up.callWithRetry('discover', {}), up.callWithRetry('discover', {})]);
    check('two calls that both hit a renamed tool both recover', () => {
      assert.deepStrictEqual(renameRace.map((r) => r.status), ['fulfilled', 'fulfilled'],
        JSON.stringify(renameRace.map((r) => r.reason?.message)));
    });

    const missingAbility = await up.callWithRetry('execute', { ability_name: 'novamira/missing', parameters: {} });
    check('an unknown ability stays ordinary tool output', () => assert.strictEqual(missingAbility.isError, true));

    const protocol = await expectError(up.callWithRetry('execute', 'not-an-object'), 'protocol');
    check('other JSON-RPC errors are reported as protocol errors, not connection failures', () => {
      assert.match(protocol.message, /arguments must be an object/);
    });

    console.log('\n== concurrency and deadlines');
    fake.state.notifyDelayMs = 300;
    const racing = new Upstream(site);
    const staggered = await Promise.allSettled([0, 150, 550].map((delay) =>
      new Promise((resolve) => setTimeout(resolve, delay)).then(() => racing.callWithRetry('discover', {}))));
    check('calls arriving during a slow handshake all succeed', () => {
      assert.deepStrictEqual(staggered.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled'],
        JSON.stringify(staggered.map((r) => r.reason?.message)));
    });

    fake.state.sessions.clear();
    const concurrent = await Promise.allSettled([racing.callWithRetry('discover', {}), racing.callWithRetry('info', {})]);
    check('two calls that both hit an expired session both recover', () => {
      assert.deepStrictEqual(concurrent.map((r) => r.status), ['fulfilled', 'fulfilled'],
        JSON.stringify(concurrent.map((r) => r.reason?.message)));
    });
    fake.state.notifyDelayMs = 0;

    fake.state.stallBody = true;
    const stalled = new Upstream({ ...site, timeoutMs: 700 });
    const stallStart = Date.now();
    await expectError(stalled.callWithRetry('discover', {}), 'transport');
    check('a site that sends headers and then stalls times out', () => assert(Date.now() - stallStart < 3000));
    fake.state.stallBody = false;

    const bounded = new Upstream({ ...site, upstreamTools: null, timeoutMs: 5000 }, { deadline: Date.now() + 800 });
    fake.state.notifyDelayMs = 600;
    fake.state.responseDelayMs = 0;
    const deadlineStart = Date.now();
    const slowList = bounded._tools();
    setTimeout(() => { fake.state.responseDelayMs = 2000; }, 10);
    await expectError(slowList, 'transport');
    check('a verification deadline covers every request together', () => assert(Date.now() - deadlineStart < 1600));
    fake.state.notifyDelayMs = 0;
    fake.state.responseDelayMs = 0;

    console.log('\n== real failures stay visible');
    const wrong = new Upstream({ ...site, password: 'x'.repeat(43) });
    const auth = await expectError(wrong.callWithRetry('discover', {}), 'auth');
    check('a rejected credential explains how to re-pair', () => assert.match(auth.message, /re-pair/i));

    fake.state.routeMissing = true;
    const fresh = new Upstream(site);
    const missing = await expectError(fresh.callWithRetry('discover', {}), 'endpoint');
    check('a missing route is still reported as a missing endpoint', () => assert.match(missing.message, /no MCP endpoint/));
    fake.state.routeMissing = false;

    const unreachable = new Upstream({ ...site, base: 'http://127.0.0.1:1' });
    await expectError(unreachable.callWithRetry('discover', {}), 'transport');
    check('an unreachable site is a transport failure', () => {});
  } finally {
    fake.server.close();
  }
  console.log(`\n${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(`Upstream self-test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
