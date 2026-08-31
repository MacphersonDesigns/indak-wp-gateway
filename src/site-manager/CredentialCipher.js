'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_VERSION = 1;

function parseMasterKey(value = process.env.REGISTRY_ENCRYPTION_KEY) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) {
    throw new Error('REGISTRY_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

/**
 * Additional authenticated data makes ciphertext non-transferable between rows. Even an
 * attacker who can edit MySQL cannot copy Site A's encrypted token into Site B and have it
 * decrypt successfully.
 */
function additionalData(site, keyVersion = KEY_VERSION) {
  const fields = [site.id, site.origin, site.mcpPath, String(keyVersion)];
  if (fields.some((value) => typeof value !== 'string' || !value)) {
    throw new Error('Credential encryption requires id, origin, and mcpPath.');
  }
  return Buffer.from(fields.join('\n'), 'utf8');
}

function encryptCredential(site, plaintext, masterKey = parseMasterKey()) {
  if (typeof plaintext !== 'string' || plaintext.length < 32) {
    throw new Error('A site credential must be a string of at least 32 characters.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  cipher.setAAD(additionalData(site));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    keyVersion: KEY_VERSION,
    fingerprint: crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex'),
  };
}

function decryptCredential(site, encrypted, masterKey = parseMasterKey()) {
  if (encrypted.keyVersion !== KEY_VERSION) {
    throw new Error(`Unsupported credential key version: ${encrypted.keyVersion}`);
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, encrypted.iv);
  decipher.setAAD(additionalData(site, encrypted.keyVersion));
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = {
  ALGORITHM,
  KEY_VERSION,
  parseMasterKey,
  encryptCredential,
  decryptCredential,
};
