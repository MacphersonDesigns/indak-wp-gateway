'use strict';

const crypto = require('crypto');

/**
 * The connector keeps only a one-way digest of its MCP credential, so it cannot present that
 * credential again after pairing. For the few calls WordPress makes back to the gateway
 * (status, disconnect) it instead presents a management token derived from the credential:
 *
 *   management = HMAC-SHA256(key = credential, message = MANAGEMENT_LABEL)
 *
 * The gateway recomputes it from the encrypted credential it already holds, so no extra secret
 * is exchanged or stored in MySQL. The token cannot be turned back into the MCP credential, and
 * it only authorizes reading this site's status or disconnecting this site.
 *
 * Keep MANAGEMENT_LABEL in sync with Indak_Gateway_Credential_Store::MANAGEMENT_LABEL.
 */
const MANAGEMENT_LABEL = 'indak-gateway-connector/management/v1';

function managementToken(credential) {
  return crypto.createHmac('sha256', String(credential)).update(MANAGEMENT_LABEL).digest('hex');
}

function managementTokenMatches(credential, presented) {
  const expected = Buffer.from(managementToken(credential), 'utf8');
  const actual = Buffer.from(String(presented || ''), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { MANAGEMENT_LABEL, managementToken, managementTokenMatches };
