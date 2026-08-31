#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createDatabasePool } = require('../src/site-manager/Database');
const { SiteRepository } = require('../src/site-manager/SiteRepository');
const { PairingService } = require('../src/site-manager/PairingService');

function fakeConnector(expectedCredential) {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${expectedCredential}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'wrong scoped token' }));
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw || '{}');
      if (String(message.method).startsWith('notifications/')) {
        res.writeHead(202);
        return res.end();
      }
      let result = {};
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-connector' } };
      } else if (message.method === 'tools/list') {
        result = { tools: [
          { name: 'fake-discover-abilities' },
          { name: 'fake-get-ability-info' },
          { name: 'fake-execute-ability' },
        ] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  let passed = 0;
  const check = (message, fn) => {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
  };
  const credential = crypto.randomBytes(32).toString('base64url');
  const connector = await fakeConnector(credential);
  const pool = createDatabasePool();
  const keyMaterial = Buffer.from('22'.repeat(32), 'hex');
  const repository = new SiteRepository(pool, keyMaterial);
  const service = new PairingService(repository, keyMaterial, {
    allowInsecure: true,
    allowPrivate: true,
    ttlMinutes: 2,
  });
  const suffix = crypto.randomBytes(4).toString('hex');
  const siteKey = `pairing-selftest-${suffix}`;
  const mcpUrl = `http://127.0.0.1:${connector.port}/divi/wp-json/mcp/novamira`;
  let siteId = null;
  try {
    const pairing = await service.createPairing({
      site_key: siteKey,
      label: 'Pairing self-test',
      mcp_url: mcpUrl,
      environment: 'staging',
      writes: true,
    }, 'admin-token-for-test'.repeat(3));
    check('manager receives a one-time display code', () => assert(/^[A-F0-9-]+$/.test(pairing.code)));

    const details = await service.pairingDetails({
      code: pairing.code,
      home_url: `http://127.0.0.1:${connector.port}`,
    });
    check('connector resolves the manager-approved subdirectory endpoint from the code', () => {
      assert.strictEqual(details.mcp_url, mcpUrl);
    });

    await assert.rejects(
      service.claimPairing({
        code: pairing.code,
        home_url: `http://127.0.0.1:${connector.port}`,
        mcp_url: `http://127.0.0.1:${connector.port}/wrong`,
        credential,
      }),
      /does not match/
    );
    console.log('  \x1b[32mPASS\x1b[0m pairing code is bound to the exact MCP path');
    passed++;

    const claimed = await service.claimPairing({
      code: pairing.code,
      home_url: `http://127.0.0.1:${connector.port}`,
      mcp_url: mcpUrl,
      credential,
      connector_version: '0.1.0-test',
    });
    siteId = claimed.runtimeSite.id;
    check('gateway calls back with scoped bearer auth before activation', () => assert(claimed.result.connected));
    check('subdirectory MCP path survives pairing', () => {
      assert.strictEqual(claimed.runtimeSite.mcpPath, '/divi/wp-json/mcp/novamira');
    });

    const loaded = await repository.listActiveSites();
    check('paired site persists encrypted in MySQL', () => assert(loaded.sites[siteKey]));
    check('paired staging site is writable', () => assert.strictEqual(loaded.sites[siteKey].writes, true));
    await assert.rejects(
      service.claimPairing({
        code: pairing.code,
        home_url: `http://127.0.0.1:${connector.port}`,
        mcp_url: mcpUrl,
        credential,
      }),
      /invalid or expired/
    );
    console.log('  \x1b[32mPASS\x1b[0m consumed pairing code cannot be replayed');
    passed++;
  } finally {
    if (siteId) await repository.deleteSiteForTest(siteId).catch(() => {});
    await repository.deletePairingsForTest(siteKey).catch(() => {});
    await pool.end();
    await new Promise((resolve) => connector.server.close(resolve));
  }
  console.log(`\n${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(`Pairing self-test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
