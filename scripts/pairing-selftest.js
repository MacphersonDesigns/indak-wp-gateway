#!/usr/bin/env node
'use strict';

/**
 * Pairing lifecycle against a real MySQL/MariaDB (npm run db:up && npm run db:migrate):
 * pair, re-pair in place, conflicts, connector status and disconnect, admin remove, and
 * re-pairing after removal or a domain move. Fake connectors stand in for WordPress.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createDatabasePool } = require('../src/site-manager/Database');
const { SiteRepository } = require('../src/site-manager/SiteRepository');
const { PairingService } = require('../src/site-manager/PairingService');
const { managementToken } = require('../src/site-manager/ConnectorAuth');

/** A fake Novamira endpoint that accepts whichever credentials are currently in `accepted`. */
function fakeConnector(accepted) {
  const server = http.createServer((req, res) => {
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!accepted.has(presented)) {
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
  const rejects = async (message, promise, pattern) => {
    await assert.rejects(promise, pattern);
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
  };

  const accepted = new Set();
  const connector = await fakeConnector(accepted);
  const moved = await fakeConnector(accepted);
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
  const otherKey = `pairing-other-${suffix}`;
  const home = `http://127.0.0.1:${connector.port}`;
  const movedHome = `http://127.0.0.1:${moved.port}`;
  // Unique subdirectories keep repeated runs from colliding with rows left by a failed run.
  const mcpUrl = `${home}/divi-${suffix}/wp-json/mcp/novamira`;
  const movedMcpUrl = `${movedHome}/wp-json/mcp/novamira`;
  const admin = 'admin-token-for-test'.repeat(3);

  const pair = async ({ key = siteKey, url = mcpUrl, homeUrl = home, input = url } = {}) => {
    const credential = crypto.randomBytes(32).toString('base64url');
    accepted.add(credential);
    const code = await service.createPairing(
      { site_key: key, label: 'Pairing self-test', mcp_url: input, environment: 'staging', writes: true },
      admin
    );
    const details = await service.pairingDetails({ code: code.code, home_url: homeUrl });
    const claimed = await service.claimPairing({
      code: code.code, home_url: homeUrl, mcp_url: details.mcp_url, credential, connector_version: '0.2.0-test',
    });
    return { code, details, claimed, credential };
  };

  try {
    console.log('\n== first pairing');
    const code = await service.createPairing({
      site_key: siteKey, label: 'Pairing self-test', mcp_url: `${home}/divi-${suffix}`, environment: 'staging', writes: true,
    }, admin);
    check('manager receives a one-time display code', () => assert(/^[A-F0-9-]+$/.test(code.code)));
    check('a bare site URL gets the standard Novamira path', () => assert.strictEqual(code.mcp_url, mcpUrl));
    check('code response includes a one-click connector link', () => {
      assert.strictEqual(
        code.connect_url,
        `${home}/divi-${suffix}/wp-admin/options-general.php?page=indak-gateway-connector&indak_gateway_code=${code.code}`
      );
    });
    check('a new site does not report a replacement', () => assert.strictEqual(code.replaces, null));

    const details = await service.pairingDetails({ code: code.code, home_url: home });
    check('connector resolves the manager-approved subdirectory endpoint', () => {
      assert.strictEqual(details.mcp_url, mcpUrl);
    });

    const firstCredential = crypto.randomBytes(32).toString('base64url');
    accepted.add(firstCredential);
    await rejects('pairing code is bound to the exact MCP path', service.claimPairing({
      code: code.code, home_url: home, mcp_url: `${home}/wrong`, credential: firstCredential,
    }), /does not match/);

    const first = await service.claimPairing({
      code: code.code, home_url: home, mcp_url: mcpUrl, credential: firstCredential, connector_version: '0.2.0-test',
    });
    check('gateway verifies scoped bearer auth before activation', () => assert(first.result.connected));
    check('first pairing is not a replacement', () => assert.strictEqual(first.result.replaced, false));

    let loaded = await repository.listActiveSites();
    check('paired site persists encrypted and keeps its subdirectory path', () => {
      assert.strictEqual(loaded.sites[siteKey].mcpPath, `/divi-${suffix}/wp-json/mcp/novamira`);
    });
    check('paired staging site is writable', () => assert.strictEqual(loaded.sites[siteKey].writes, true));
    const listed = (await repository.listSitesForAdmin()).find((site) => site.site_key === siteKey);
    check('connector version is recorded', () => assert.strictEqual(listed.connector_version, '0.2.0-test'));
    await rejects('consumed pairing code cannot be replayed', service.claimPairing({
      code: code.code, home_url: home, mcp_url: mcpUrl, credential: firstCredential,
    }), /invalid or expired/);

    console.log('\n== re-pair without touching the database');
    const again = await pair();
    check('re-pairing the same key and endpoint is announced to the manager', () => {
      assert.deepStrictEqual(again.code.replaces, { site_key: siteKey, label: 'Pairing self-test' });
    });
    check('re-pairing replaces the existing row in place', () => {
      assert.strictEqual(again.claimed.result.replaced, true);
      assert.strictEqual(again.claimed.siteId, first.siteId);
    });
    loaded = await repository.listActiveSites();
    check('the new credential replaced the old one', () => {
      assert.strictEqual(loaded.sites[siteKey].password, again.credential);
    });

    console.log('\n== conflicts');
    await rejects('a key already active for another endpoint is refused up front', service.createPairing({
      site_key: siteKey, label: 'x', mcp_url: movedMcpUrl, environment: 'staging',
    }, admin), (error) => error.status === 409 && /already connected to/.test(error.message));
    await rejects('an endpoint already active under another key is refused up front', service.createPairing({
      site_key: otherKey, label: 'x', mcp_url: mcpUrl, environment: 'staging',
    }, admin), (error) => error.status === 409 && /already connected as/.test(error.message));

    console.log('\n== connector status and disconnect');
    const token = managementToken(again.credential);
    const statusInput = { site_key: siteKey, home_url: home, connector_version: '0.2.1-test' };
    const status = await service.connectorStatus({ ...statusInput, verify: true }, token);
    check('connector status authenticates with the derived management token', () => {
      assert.strictEqual(status.connected, true);
      assert.deepStrictEqual(status.check, { ok: true });
    });
    await rejects('a wrong management token is indistinguishable from an unknown site',
      service.connectorStatus(statusInput, managementToken(firstCredential)),
      (error) => error.status === 404);
    await rejects('the management token is bound to the site origin',
      service.connectorStatus({ ...statusInput, home_url: movedHome }, token),
      (error) => error.status === 404);

    await service.connectorDisconnect(statusInput, token);
    loaded = await repository.listActiveSites();
    check('disconnect from WordPress removes the site from routing', () => assert(!loaded.sites[siteKey]));
    const disabled = (await repository.listSitesForAdmin()).find((site) => site.site_key === siteKey);
    check('disconnect erases the stored credential and keeps history', () => {
      assert.strictEqual(disabled.status, 'disabled');
      assert.strictEqual(disabled.credential_fingerprint, null);
    });
    await rejects('a disconnected site cannot be disconnected again',
      service.connectorDisconnect(statusInput, token), (error) => error.status === 404);

    const afterDisconnect = await pair();
    check('re-pairing after disconnect reuses the same row', () => {
      assert.strictEqual(afterDisconnect.claimed.siteId, first.siteId);
      assert.strictEqual(afterDisconnect.code.replaces, null);
    });

    console.log('\n== failures around the commit');
    const flaky = Object.create(repository);
    flaky.upsertPairedSite = async () => { throw new Error('Lost connection to MySQL server'); };
    const flakyService = new PairingService(flaky, keyMaterial, { allowInsecure: true, allowPrivate: true });
    const flakyCode = await service.createPairing({ site_key: siteKey, label: 'Pairing self-test', mcp_url: mcpUrl, environment: 'staging' }, admin);
    const flakyCredential = crypto.randomBytes(32).toString('base64url');
    accepted.add(flakyCredential);
    await rejects('an unknown commit outcome is a 503, so WordPress keeps the credential pending',
      flakyService.claimPairing({ code: flakyCode.code, home_url: home, mcp_url: mcpUrl, credential: flakyCredential }),
      (error) => error.status === 503);
    await rejects('a consumed code is a definite 400 refusal',
      service.claimPairing({ code: flakyCode.code, home_url: home, mcp_url: mcpUrl, credential: flakyCredential }),
      (error) => error.status === 400);

    const noisy = Object.create(repository);
    noisy.recordConnectorVersion = async () => { throw new Error('Lock wait timeout exceeded'); };
    let bookkeeping = null;
    const noisyService = new PairingService(noisy, keyMaterial, {
      allowInsecure: true, allowPrivate: true, onBookkeepingError: (error) => { bookkeeping = error.message; },
    });
    const noisyCode = await service.createPairing({ site_key: siteKey, label: 'Pairing self-test', mcp_url: mcpUrl, environment: 'staging' }, admin);
    const noisyCredential = crypto.randomBytes(32).toString('base64url');
    accepted.add(noisyCredential);
    const noisyClaim = await noisyService.claimPairing({ code: noisyCode.code, home_url: home, mcp_url: mcpUrl, credential: noisyCredential });
    check('a bookkeeping failure after the commit does not fail the pairing', () => {
      assert.strictEqual(noisyClaim.result.connected, true);
      assert.match(bookkeeping, /Lock wait/);
    });

    console.log('\n== admin remove, verify, and domain move');
    const verified = await service.adminVerify(siteKey);
    check('admin test reaches the site end to end', () => assert.strictEqual(verified.ok, true));
    accepted.clear();
    const broken = await service.adminVerify(siteKey);
    check('admin test reports a rejected credential without throwing', () => {
      assert.strictEqual(broken.ok, false);
      assert(/rejected the gateway credential/.test(broken.error));
    });
    const brokenRow = (await repository.listSitesForAdmin()).find((site) => site.site_key === siteKey);
    check('the failure is recorded for the Site Manager', () => assert(/rejected/.test(brokenRow.last_error)));

    const removed = await service.adminRemove(siteKey, admin);
    check('admin remove disables the site', () => assert.strictEqual(removed.already_removed, false));
    await rejects('a removed site cannot be tested', service.adminVerify(siteKey), (error) => error.status === 404);

    const movedPair = await pair({ url: movedMcpUrl, homeUrl: movedHome, input: movedHome });
    check('a removed key can be re-paired to a new domain', () => {
      assert.strictEqual(movedPair.claimed.siteId, first.siteId);
    });
    loaded = await repository.listActiveSites();
    check('routing follows the site to its new domain', () => assert.strictEqual(loaded.sites[siteKey].base, movedHome));

    await service.adminRemove(siteKey, admin);
    const takeover = await pair({ key: otherKey, url: movedMcpUrl, homeUrl: movedHome, input: movedMcpUrl });
    check('a new key can take over an endpoint whose old row was removed', () => {
      assert.strictEqual(takeover.claimed.result.connected, true);
      assert.notStrictEqual(takeover.claimed.siteId, first.siteId);
    });
    loaded = await repository.listActiveSites();
    check('only the new key routes after the takeover', () => {
      assert(loaded.sites[otherKey]);
      assert(!loaded.sites[siteKey]);
    });
    check('the removed key stays a tombstone after the takeover', () => assert(loaded.removedKeys.includes(siteKey)));
  } finally {
    const rows = await repository.listSitesForAdmin().catch(() => []);
    for (const row of rows.filter((site) => [siteKey, otherKey].includes(site.site_key))) {
      await repository.deleteSiteForTest(row.id).catch(() => {});
    }
    await repository.deletePairingsForTest(siteKey).catch(() => {});
    await repository.deletePairingsForTest(otherKey).catch(() => {});
    await pool.end();
    await new Promise((resolve) => connector.server.close(resolve));
    await new Promise((resolve) => moved.server.close(resolve));
  }
  console.log(`\n${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(`Pairing self-test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
