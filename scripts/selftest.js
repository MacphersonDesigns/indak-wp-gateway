#!/usr/bin/env node
'use strict';
/**
 * Offline end-to-end test. Spins up two FAKE Novamira installs on localhost,
 * boots the gateway against them, and asserts routing plus every guardrail.
 * No network, no WordPress needed:  npm run selftest
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  \x1b[32mPASS\x1b[0m ${m}`); pass++; };
const no = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); fail++; };

/** A pretend Novamira MCP endpoint that reports its own identity. */
function fakeWordPress(label, expectedPassword) {
  const srv = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    const [u, p] = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
    if (u !== 'novamira-bot' || p !== expectedPassword) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 'unauthorized' }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      const send = (result) => {
        // Answer in SSE framing to prove the gateway parses both shapes.
        const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': `sess-${label}` });
        res.end(`event: message\ndata: ${payload}\n\n`);
      };
      if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: label } });
      if (String(msg.method).startsWith('notifications/')) { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') {
        return send({ tools: [
          { name: 'mcp-adapter-discover-abilities' },
          { name: 'mcp-adapter-get-ability-info' },
          { name: 'mcp-adapter-execute-ability' },
        ] });
      }
      if (msg.method === 'tools/call') {
        const n = msg.params.name;
        if (n.endsWith('discover-abilities')) {
          return send({ content: [{ type: 'text', text: JSON.stringify({ site_identity: label, abilities: [{ name: 'novamira/execute-php' }] }) }] });
        }
        if (n.endsWith('get-ability-info')) return send({ content: [{ type: 'text', text: `info from ${label}` }] });
        if (n.endsWith('execute-ability')) return send({ content: [{ type: 'text', text: `EXECUTED on ${label}` }] });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

(async () => {
  const live = await fakeWordPress('FAKE-LIVE', 'pw-live');
  const staging = await fakeWordPress('FAKE-STAGING', 'pw-staging');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpgw-'));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({
    indak:        { label: 'Indak Media',            base: `http://127.0.0.1:${live.port}`,    env: 'live',    appPasswordEnv: 'WP_PW_INDAK',        writes: true,  rateLimitPerMin: 500 },
    strengthennd: { label: 'Strengthen ND (staging)', base: `http://127.0.0.1:${staging.port}`, env: 'staging', appPasswordEnv: 'WP_PW_STRENGTHENND', writes: false, rateLimitPerMin: 500 },
    nodomain:     { label: 'Not onboarded yet',      env: 'staging' },
  }, null, 2));

  const TOKEN = 'a'.repeat(64), RO = 'b'.repeat(64);
  const PORT = 41971;
  const gw2 = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), GATEWAY_TOKEN: TOKEN, GATEWAY_TOKEN_READONLY: RO,
           REGISTRY_FILE: registry, ALLOW_INSECURE_UPSTREAM: 'true',
           WP_PW_INDAK: 'pw-live', WP_PW_STRENGTHENND: 'pw-staging', HOST: '127.0.0.1',
           // An unreachable database proves the legacy registry remains available during a
           // Hostinger/MySQL outage. Connected persistence is covered by site-manager-selftest.
           DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'unreachable', DB_USER: 'unreachable',
           DB_PASSWORD: 'unreachable', DB_CONNECT_TIMEOUT_MS: '1000',
           REGISTRY_ENCRYPTION_KEY: '12'.repeat(32) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let boot = '';
  gw2.stdout.on('data', (d) => { boot += d.toString(); });
  await new Promise((r) => setTimeout(r, 1500));

  const base = `http://127.0.0.1:${PORT}`;
  const rpc = async (method, params, token = TOKEN) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, body: await res.text() };
  };
  const call = (name, args, token) => rpc('tools/call', { name, arguments: args }, token);

  console.log('\n== boot');
  boot.includes('"event":"boot"') ? ok('gateway booted with a JSON audit line') : no(`no boot log: ${boot}`);
  boot.includes('no base URL yet') ? ok('site without a base URL was skipped, loudly') : no('unfinished site was not reported');

  console.log('\n== health + auth');
  const h = await (await fetch(`${base}/healthz`)).json();
  h.ok && h.sites === 2 ? ok(`healthz -> ${JSON.stringify(h)}`) : no(`healthz -> ${JSON.stringify(h)}`);
  h.database === 'degraded' ? ok('database outage preserved the environment registry') : no(`database fallback -> ${JSON.stringify(h)}`);
  const un = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  un.status === 401 ? ok('no token -> 401') : no(`no token -> ${un.status}`);
  const bad = await rpc('tools/list', {}, 'c'.repeat(64));
  bad.status === 401 ? ok('wrong token -> 401') : no(`wrong token -> ${bad.status}`);

  console.log('\n== protocol');
  const init = JSON.parse((await rpc('initialize', { protocolVersion: '2025-06-18' })).body);
  init.result?.serverInfo?.name === 'indak-wp-gateway' ? ok('initialize handshake answered') : no(JSON.stringify(init));
  const tl = JSON.parse((await rpc('tools/list', {})).body);
  const names = tl.result.tools.map((t) => t.name);
  names.length === 4 ? ok(`exactly 4 tools: ${names.join(', ')}`) : no(`${names.length} tools: ${names.join(', ')}`);

  console.log('\n== routing');
  const sites = (await call('wp_list_sites', {})).body;
  sites.includes('strengthennd') && sites.includes('indak') ? ok('wp_list_sites returns both keys') : no(sites);
  const a = (await call('wp_discover_abilities', { site: 'indak' })).body;
  const b = (await call('wp_discover_abilities', { site: 'strengthennd' })).body;
  a.includes('FAKE-LIVE') ? ok('indak answered with ITS OWN identity') : no(a.slice(0, 300));
  b.includes('FAKE-STAGING') ? ok('strengthennd answered with ITS OWN identity') : no(b.slice(0, 300));
  a !== b ? ok('both sites reachable in the same run with different payloads') : no('identical payloads: routing broken');
  ok('SSE-framed upstream responses parsed');

  console.log('\n== guardrails');
  const typo = (await call('wp_discover_abilities', { site: 'strengthend' })).body;
  /Unknown site/.test(typo) && /Did you mean/.test(typo) ? ok('typo refused with a suggestion') : no(typo.slice(0, 300));

  const wr = (await call('wp_execute_ability', { site: 'strengthennd', ability_name: 'novamira/write-file', parameters: {} })).body;
  /Writes are disabled/.test(wr) ? ok('write refused where writes:false') : no(wr.slice(0, 300));

  const rd = (await call('wp_execute_ability', { site: 'strengthennd', ability_name: 'novamira/read-file', parameters: { path: 'x' } })).body;
  /EXECUTED on FAKE-STAGING/.test(rd) ? ok('read still allowed where writes:false') : no(rd.slice(0, 300));

  const php = (await call('wp_execute_ability', { site: 'indak', ability_name: 'novamira/execute-php', parameters: { code: 'return 1;' } })).body;
  /LIVE site/.test(php) ? ok('execute-php blocked on a LIVE site even with writes:true') : no(php.slice(0, 300));

  const unknown = (await call('wp_execute_ability', { site: 'strengthennd', ability_name: 'novamira/frobnicate-widget', parameters: {} })).body;
  /unrecognised ability/.test(unknown) ? ok('unknown ability treated as a write (default-deny)') : no(unknown.slice(0, 300));

  const roWrite = (await call('wp_execute_ability', { site: 'indak', ability_name: 'aioseo-redirects/create', parameters: {} }, RO)).body;
  /read-only/.test(roWrite) ? ok('read-only token blocked from writing') : no(roWrite.slice(0, 300));
  const roRead = (await call('wp_discover_abilities', { site: 'indak' }, RO)).body;
  roRead.includes('FAKE-LIVE') ? ok('read-only token can still read') : no(roRead.slice(0, 300));

  const errIsToolOutput = JSON.parse(wr);
  errIsToolOutput.result?.isError === true && !errIsToolOutput.error
    ? ok('refusals come back as tool output, not protocol errors') : no('refusal shape wrong');

  console.log('\n== audit log');
  boot = '';
  await call('wp_execute_ability', { site: 'indak', ability_name: 'novamira/execute-php', parameters: {} });
  await new Promise((r) => setTimeout(r, 150));
  /"event":"deny".*"reason":"live root block"/.test(boot) ? ok('denials are audit-logged with a reason') : no(`audit log: ${boot}`);

  gw2.kill(); live.srv.close(); staging.srv.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
