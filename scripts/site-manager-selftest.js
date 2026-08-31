#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabasePool } = require('../src/site-manager/Database');
const { encryptCredential, decryptCredential } = require('../src/site-manager/CredentialCipher');
const { SiteRepository } = require('../src/site-manager/SiteRepository');
const { mergeRegistries } = require('../src/site-manager/RegistryMerge');

const TEST_KEY = Buffer.from('11'.repeat(32), 'hex');

async function run() {
  let checks = 0;
  const check = (message, fn) => {
    fn();
    checks++;
    console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
  };

  const identity = {
    id: '11111111-1111-4111-8111-111111111111',
    origin: 'https://stage.example.com',
    mcpPath: '/divi/wp-json/mcp/novamira',
  };
  const credential = 'site-secret-' + 'a'.repeat(40);
  const encrypted = encryptCredential(identity, credential, TEST_KEY);
  check('AES-256-GCM credential round trip', () => {
    assert.strictEqual(decryptCredential(identity, encrypted, TEST_KEY), credential);
  });
  check('ciphertext does not contain plaintext', () => {
    assert(!encrypted.ciphertext.includes(Buffer.from(credential)));
  });
  check('credential cannot move to a different endpoint', () => {
    assert.throws(() => decryptCredential({ ...identity, mcpPath: '/other' }, encrypted, TEST_KEY));
  });

  const pool = createDatabasePool();
  const repository = new SiteRepository(pool, TEST_KEY);
  const id = crypto.randomUUID();
  try {
    await repository.ping();
    console.log('  \x1b[32mPASS\x1b[0m bounded MySQL pool connected');
    checks++;
    await repository.insertActiveSite({
      id,
      key: `selftest-${id.slice(0, 8)}`,
      label: 'Self-test staging',
      origin: 'https://stage.example.com',
      mcpPath: `/selftest-${id}/wp-json/mcp/novamira`,
      env: 'staging',
      writes: true,
      upstreamTools: { discover: 'x-discover-abilities', info: 'x-get-ability-info', execute: 'x-execute-ability' },
    }, credential);
    const loaded = await repository.listActiveSites();
    const site = Object.values(loaded.sites).find((candidate) => candidate.id === id);
    check('encrypted database row loads into runtime registry', () => assert(site));
    check('database runtime site uses scoped bearer auth', () => assert.strictEqual(site.authType, 'scoped-bearer'));
    check('staging write flag persists', () => assert.strictEqual(site.writes, true));

    const merged = mergeRegistries({ sites: { legacy: { key: 'legacy' } }, skipped: [] }, loaded);
    check('database sites merge with environment fallback', () => {
      assert(merged.sites.legacy);
      assert(merged.sites[site.key]);
    });
  } finally {
    await repository.deleteSiteForTest(id).catch(() => {});
    await pool.end();
  }

  console.log(`\n${checks} passed, 0 failed`);
}

run().catch((error) => {
  console.error(`Site Manager self-test failed: ${error.message}`);
  process.exitCode = 1;
});
