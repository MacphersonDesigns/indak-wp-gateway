'use strict';

const crypto = require('crypto');
const { normalizeMcpUrl, assertPublicEndpoint, normalizeSiteKey } = require('./EndpointValidator');
const { Upstream } = require('../upstream');

function codeDigest(code, masterKey) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHmac('sha256', masterKey)
    .update('indak-gateway-pairing-v1\0')
    .update(normalized)
    .digest();
}

function createDisplayCode() {
  return crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

function tokenFingerprint(value, length = 16) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

class PairingService {
  constructor(repository, masterKey, options = {}) {
    this.repository = repository;
    this.masterKey = masterKey;
    this.allowInsecure = Boolean(options.allowInsecure);
    this.allowPrivate = Boolean(options.allowPrivate);
    this.ttlMinutes = Math.min(Math.max(Number(options.ttlMinutes) || 10, 2), 30);
  }

  async createPairing(input, actorToken) {
    const endpoint = normalizeMcpUrl(input.mcp_url, { allowInsecure: this.allowInsecure });
    await assertPublicEndpoint(endpoint, { allowPrivate: this.allowPrivate });
    const key = normalizeSiteKey(input.site_key);
    const label = String(input.label || '').trim();
    if (!label || label.length > 180) throw new Error('label is required and must be at most 180 characters.');
    const environment = input.environment === 'live' ? 'live'
      : input.environment === 'staging' ? 'staging'
      : null;
    if (!environment) throw new Error('environment must be "staging" or "live".');

    const code = createDisplayCode();
    const pairing = {
      id: crypto.randomUUID(),
      codeDigest: codeDigest(code, this.masterKey),
      expectedOrigin: endpoint.origin,
      expectedMcpPath: endpoint.mcpPath,
      siteKey: key,
      label,
      environment,
      writes: environment === 'staging' && input.writes !== false,
      expiresAt: new Date(Date.now() + this.ttlMinutes * 60000),
      actorFingerprint: tokenFingerprint(actorToken),
    };
    await this.repository.createPairingCode(pairing);
    await this.repository.insertAuditEvent({
      eventType: 'pairing_code_created', actorType: 'admin',
      actorFingerprint: pairing.actorFingerprint,
      details: { site_key: key, origin: endpoint.origin, mcp_path: endpoint.mcpPath },
    });
    return { code, expires_at: pairing.expiresAt.toISOString(), site_key: key, mcp_url: endpoint.url };
  }

  async pairingDetails(input) {
    const home = normalizeMcpUrl(String(input.home_url || '').replace(/\/$/, '') + '/placeholder', {
      allowInsecure: this.allowInsecure,
    });
    const pairing = await this.repository.inspectPairingCode(
      codeDigest(input.code, this.masterKey),
      home.origin
    );
    return {
      site_key: pairing.siteKey,
      label: pairing.label,
      environment: pairing.environment,
      mcp_url: pairing.origin + pairing.mcpPath,
    };
  }

  async claimPairing(input) {
    const endpoint = normalizeMcpUrl(input.mcp_url, { allowInsecure: this.allowInsecure });
    await assertPublicEndpoint(endpoint, { allowPrivate: this.allowPrivate });
    const home = normalizeMcpUrl(String(input.home_url || '').replace(/\/$/, '') + '/placeholder', {
      allowInsecure: this.allowInsecure,
    });
    if (home.origin !== endpoint.origin) throw new Error('home_url and mcp_url must have the same origin.');
    const credential = String(input.credential || '');
    if (credential.length < 43 || credential.length > 256) {
      throw new Error('Connector credential must contain 256 bits of random data.');
    }

    // Consumption is atomic and happens before the callback. A code cannot be reused as an
    // SSRF oracle when an upstream validation fails.
    const pairing = await this.repository.consumePairingCode(
      codeDigest(input.code, this.masterKey), endpoint.origin, endpoint.mcpPath
    );
    const site = {
      id: crypto.randomUUID(),
      key: pairing.siteKey,
      label: pairing.label,
      origin: pairing.expectedOrigin,
      base: pairing.expectedOrigin,
      mcpPath: pairing.expectedMcpPath,
      env: pairing.environment,
      writes: pairing.writes,
      rateLimitPerMin: 30,
      timeoutMs: 120000,
      password: credential,
      authType: 'scoped-bearer',
    };

    const upstream = new Upstream(site);
    const toolMap = await upstream._tools();
    site.upstreamTools = toolMap;
    await this.repository.insertActiveSite(site, credential);
    await this.repository.insertAuditEvent({
      eventType: 'site_paired', siteId: site.id, actorType: 'connector',
      actorFingerprint: tokenFingerprint(credential),
      details: { site_key: site.key, connector_version: String(input.connector_version || 'unknown') },
    });
    return {
      result: { connected: true, site_key: site.key, label: site.label, environment: site.env },
      // Kept in process memory only so the newly paired site is immediately routable without
      // restarting Hostinger. HTTP handlers must serialize result, never runtimeSite.
      runtimeSite: { ...site },
    };
  }
}

module.exports = { PairingService, codeDigest, createDisplayCode, tokenFingerprint };
