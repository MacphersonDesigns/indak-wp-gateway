'use strict';

const crypto = require('crypto');
const {
  normalizeMcpUrl,
  normalizeSiteInput,
  connectorSettingsUrl,
  assertPublicEndpoint,
  normalizeSiteKey,
} = require('./EndpointValidator');
const { managementTokenMatches } = require('./ConnectorAuth');
const { PairingError } = require('./errors');
const { Upstream } = require('../upstream');

// WordPress waits up to 45 seconds for a claim and 35 for a status check with verify (see
// Indak_Gateway_Pairing_Client). This is the total for the whole callback, across every
// request, so the gateway answers well inside those limits.
const CALLBACK_TIMEOUT_MS = 20000;

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

/** Initialize and list tools against one site with a fresh client, within one total deadline. */
async function verifyEndpoint(site, timeoutMs = CALLBACK_TIMEOUT_MS) {
  const upstream = new Upstream({ ...site, upstreamTools: null, timeoutMs }, { deadline: Date.now() + timeoutMs });
  return upstream._tools();
}

/** Run a validation step and turn its failure into an explicit 400 refusal. */
async function refuseOnError(step) {
  try {
    return await step();
  } catch (error) {
    if (error.status) throw error;
    throw new PairingError(error.message, 400);
  }
}

class PairingService {
  constructor(repository, masterKey, options = {}) {
    this.repository = repository;
    this.masterKey = masterKey;
    this.allowInsecure = Boolean(options.allowInsecure);
    this.allowPrivate = Boolean(options.allowPrivate);
    this.ttlMinutes = Math.min(Math.max(Number(options.ttlMinutes) || 10, 2), 30);
    this.verify = options.verifyEndpoint || verifyEndpoint;
    this.onBookkeepingError = options.onBookkeepingError || null;
  }

  originOf(homeUrl) {
    return normalizeMcpUrl(String(homeUrl || '').replace(/\/$/, '') + '/placeholder', {
      allowInsecure: this.allowInsecure,
    }).origin;
  }

  async createPairing(input, actorToken) {
    const endpoint = normalizeSiteInput(input.mcp_url, { allowInsecure: this.allowInsecure });
    await assertPublicEndpoint(endpoint, { allowPrivate: this.allowPrivate });
    const key = normalizeSiteKey(input.site_key);
    const label = String(input.label || '').trim();
    if (!label || label.length > 180) throw new Error('label is required and must be at most 180 characters.');
    const environment = input.environment === 'live' ? 'live'
      : input.environment === 'staging' ? 'staging'
      : null;
    if (!environment) throw new Error('environment must be "staging" or "live".');

    // Surface key and endpoint conflicts now instead of after the WordPress admin has used
    // the code. The claim repeats this check inside a locking transaction.
    const replaces = await this.repository.previewPairing(key, endpoint.origin, endpoint.mcpPath);

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
      details: { site_key: key, origin: endpoint.origin, mcp_path: endpoint.mcpPath, replaces: Boolean(replaces) },
    });
    const settingsUrl = connectorSettingsUrl(endpoint);
    return {
      code,
      expires_at: pairing.expiresAt.toISOString(),
      site_key: key,
      label,
      mcp_url: endpoint.url,
      replaces,
      connector_url: settingsUrl,
      connect_url: `${settingsUrl}&indak_gateway_code=${encodeURIComponent(code)}`,
    };
  }

  async pairingDetails(input) {
    const origin = await refuseOnError(() => this.originOf(input.home_url));
    const pairing = await this.repository.inspectPairingCode(codeDigest(input.code, this.masterKey), origin);
    return {
      site_key: pairing.siteKey,
      label: pairing.label,
      environment: pairing.environment,
      mcp_url: pairing.origin + pairing.mcpPath,
    };
  }

  /**
   * Answer statuses matter here. A 4xx tells WordPress the pairing was refused, so it discards
   * the credential it offered; a 5xx means the outcome is unknown, so it keeps the credential
   * pending and can ask /connector/status later. Only definite refusals may be 4xx.
   */
  async claimPairing(input) {
    const endpoint = await refuseOnError(async () => {
      const normalized = normalizeMcpUrl(input.mcp_url, { allowInsecure: this.allowInsecure });
      await assertPublicEndpoint(normalized, { allowPrivate: this.allowPrivate });
      if (this.originOf(input.home_url) !== normalized.origin) {
        throw new Error('home_url and mcp_url must have the same origin.');
      }
      return normalized;
    });
    const credential = String(input.credential || '');
    if (credential.length < 43 || credential.length > 256) {
      throw new PairingError('Connector credential must contain 256 bits of random data.');
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

    try {
      site.upstreamTools = await this.verify(site);
    } catch (error) {
      // The code is consumed and nothing was stored, so this is a definite refusal.
      throw new PairingError(
        `The gateway could not reach this site's Novamira endpoint with the new credential ` +
        `(${error.message}). Create a new pairing code and try again.`
      );
    }
    let stored;
    try {
      stored = await this.repository.upsertPairedSite(site, credential);
    } catch (error) {
      if (error.status) throw error;
      // The commit may or may not have happened; WordPress should keep the credential pending.
      throw new PairingError('The gateway could not confirm that it saved this connection. Choose Check connection.', 503);
    }
    site.id = stored.id;
    const connectorVersion = String(input.connector_version || 'unknown').slice(0, 32);
    // The pairing is committed. Bookkeeping failures below must not turn it into an error,
    // or WordPress would discard a credential the gateway has already activated.
    try {
      await this.repository.recordConnectorVersion(site.id, connectorVersion);
      await this.repository.insertAuditEvent({
        eventType: stored.replaced ? 'site_repaired' : 'site_paired',
        siteId: site.id, actorType: 'connector',
        actorFingerprint: tokenFingerprint(credential),
        details: {
          site_key: site.key,
          connector_version: connectorVersion,
          ...(stored.replaced ? { replaced_status: stored.replaced.status } : {}),
        },
      });
    } catch (error) {
      this.onBookkeepingError?.(error, site.key);
    }
    return {
      result: {
        connected: true,
        site_key: site.key,
        label: site.label,
        environment: site.env,
        // Only an active connection counts as replaced; re-pairing after a disconnect or
        // removal is a fresh connection from the team's point of view.
        replaced: stored.replaced?.status === 'active',
      },
      siteId: site.id,
    };
  }

  /**
   * Authenticate a connector's management call. Every failure looks the same to the caller
   * so the endpoint cannot be used to probe which sites are paired.
   */
  async authenticateConnector(input, presentedToken) {
    const denied = new PairingError('This site is not connected to the gateway.', 404);
    let key;
    let origin;
    try {
      key = normalizeSiteKey(input.site_key);
      origin = this.originOf(input.home_url);
    } catch {
      throw denied;
    }
    const site = await this.repository.activeSiteByKey(key);
    if (!site || site.base !== origin || !managementTokenMatches(site.password, presentedToken)) {
      throw denied;
    }
    return site;
  }

  async connectorStatus(input, presentedToken) {
    const site = await this.authenticateConnector(input, presentedToken);
    if (input.connector_version) {
      await this.repository.recordConnectorVersion(site.id, input.connector_version);
    }
    let check = null;
    if (input.verify === true) {
      try {
        const tools = await this.verify(site);
        await this.repository.recordCheck(site.id, { ok: true, upstreamTools: tools });
        check = { ok: true };
      } catch (error) {
        await this.repository.recordCheck(site.id, { ok: false, error: error.message });
        check = { ok: false, error: error.message };
      }
    }
    const summary = await this.repository.siteSummaryByKey(site.key);
    return {
      connected: true,
      site_key: site.key,
      label: site.label,
      environment: site.env,
      writes: site.writes,
      last_verified_at: summary?.last_verified_at || null,
      last_error: summary?.last_error || null,
      check,
    };
  }

  async connectorDisconnect(input, presentedToken) {
    const site = await this.authenticateConnector(input, presentedToken);
    await this.repository.disableSite(site.id, 'Disconnected from WordPress.');
    await this.repository.insertAuditEvent({
      eventType: 'site_disconnected', siteId: site.id, actorType: 'connector',
      actorFingerprint: tokenFingerprint(site.password),
      details: { site_key: site.key, connector_version: String(input.connector_version || 'unknown').slice(0, 32) },
    });
    return { disconnected: true, site_key: site.key };
  }

  async adminRemove(siteKey, actorToken) {
    const key = normalizeSiteKey(siteKey);
    const summary = await this.repository.siteSummaryByKey(key);
    if (!summary) throw new PairingError(`No paired site uses the key "${key}".`, 404);
    const changed = await this.repository.disableSite(summary.id, 'Removed in the Site Manager.');
    if (changed) {
      await this.repository.insertAuditEvent({
        eventType: 'site_removed', siteId: summary.id, actorType: 'admin',
        actorFingerprint: tokenFingerprint(actorToken),
        details: { site_key: key },
      });
    }
    return { removed: true, site_key: key, already_removed: !changed };
  }

  async adminVerify(siteKey) {
    const key = normalizeSiteKey(siteKey);
    const site = await this.repository.activeSiteByKey(key);
    if (!site) throw new PairingError(`"${key}" is not an active paired site. Re-pair it first.`, 404);
    try {
      const tools = await this.verify(site);
      await this.repository.recordCheck(site.id, { ok: true, upstreamTools: tools });
      return { ok: true, site_key: key };
    } catch (error) {
      await this.repository.recordCheck(site.id, { ok: false, error: error.message });
      return { ok: false, site_key: key, error: error.message };
    }
  }
}

module.exports = {
  PairingService,
  PairingError,
  CALLBACK_TIMEOUT_MS,
  codeDigest,
  createDisplayCode,
  tokenFingerprint,
  verifyEndpoint,
};
