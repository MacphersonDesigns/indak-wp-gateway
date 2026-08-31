'use strict';

const { decryptCredential, encryptCredential } = require('./CredentialCipher');

function runtimeSiteFromRow(row, credential) {
  let upstreamTools = null;
  if (row.upstream_tools_json) {
    upstreamTools = typeof row.upstream_tools_json === 'string'
      ? JSON.parse(row.upstream_tools_json)
      : row.upstream_tools_json;
  }
  return {
    id: row.id,
    key: row.site_key,
    label: row.label,
    base: row.origin,
    mcpPath: row.mcp_path,
    user: null,
    password: credential,
    authType: 'scoped-bearer',
    writes: Boolean(row.writes_enabled),
    env: row.environment,
    rateLimitPerMin: Number(row.rate_limit_per_minute),
    upstreamTools,
    timeoutMs: Number(row.timeout_ms),
    source: 'database',
  };
}

class SiteRepository {
  constructor(pool, masterKey) {
    this.pool = pool;
    this.masterKey = masterKey;
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  async listActiveSites() {
    const [rows] = await this.pool.execute(
      `SELECT id, site_key, label, origin, mcp_path, environment, writes_enabled,
              credential_ciphertext, credential_iv, credential_tag, credential_key_version,
              upstream_tools_json, rate_limit_per_minute, timeout_ms
         FROM sites
        WHERE status = 'active'
        ORDER BY site_key`
    );
    const sites = {};
    const skipped = [];
    for (const row of rows) {
      try {
        if (!row.credential_ciphertext || !row.credential_iv || !row.credential_tag) {
          throw new Error('active row has no encrypted credential');
        }
        const identity = { id: row.id, origin: row.origin, mcpPath: row.mcp_path };
        const credential = decryptCredential(identity, {
          ciphertext: row.credential_ciphertext,
          iv: row.credential_iv,
          tag: row.credential_tag,
          keyVersion: Number(row.credential_key_version),
        }, this.masterKey);
        sites[row.site_key] = runtimeSiteFromRow(row, credential);
      } catch (error) {
        skipped.push({ key: row.site_key, why: `database credential could not be loaded: ${error.message}` });
      }
    }
    return { sites, skipped };
  }

  async listSitesForAdmin() {
    const [rows] = await this.pool.execute(
      `SELECT id, site_key, label, origin, mcp_path, environment, writes_enabled, status,
              credential_fingerprint, last_verified_at, last_error, created_at, updated_at
         FROM sites ORDER BY label, site_key`
    );
    return rows.map((row) => ({
      id: row.id,
      site_key: row.site_key,
      label: row.label,
      mcp_url: row.origin + row.mcp_path,
      environment: row.environment,
      writes: Boolean(row.writes_enabled),
      status: row.status,
      credential_fingerprint: row.credential_fingerprint,
      last_verified_at: row.last_verified_at,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  async createPairingCode(pairing) {
    await this.pool.execute(
      `INSERT INTO pairing_codes (
         id, code_digest, expected_origin, expected_mcp_path, requested_site_key,
         requested_label, environment, writes_enabled, expires_at, created_by_fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pairing.id, pairing.codeDigest, pairing.expectedOrigin, pairing.expectedMcpPath,
        pairing.siteKey, pairing.label, pairing.environment, pairing.writes,
        pairing.expiresAt, pairing.actorFingerprint]
    );
  }

  async inspectPairingCode(digest, origin) {
    const [rows] = await this.pool.execute(
      `SELECT expected_origin, expected_mcp_path, requested_site_key, requested_label,
              environment, expires_at, consumed_at
         FROM pairing_codes WHERE code_digest = ? LIMIT 1`,
      [digest]
    );
    const row = rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) {
      throw new Error('Pairing code is invalid or expired.');
    }
    if (row.expected_origin !== origin) {
      throw new Error('Pairing code does not match this WordPress site.');
    }
    return {
      origin: row.expected_origin,
      mcpPath: row.expected_mcp_path,
      siteKey: row.requested_site_key,
      label: row.requested_label,
      environment: row.environment,
    };
  }

  async consumePairingCode(digest, origin, mcpPath) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, expected_origin, expected_mcp_path, requested_site_key, requested_label,
                environment, writes_enabled, failed_attempts, expires_at, consumed_at
           FROM pairing_codes WHERE code_digest = ? FOR UPDATE`,
        [digest]
      );
      const row = rows[0];
      if (!row) throw new Error('Pairing code is invalid or expired.');
      if (row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) {
        throw new Error('Pairing code is invalid or expired.');
      }
      if (row.expected_origin !== origin || row.expected_mcp_path !== mcpPath) {
        await connection.execute(
          `UPDATE pairing_codes
              SET failed_attempts = failed_attempts + 1,
                  consumed_at = CASE WHEN failed_attempts + 1 >= 5 THEN CURRENT_TIMESTAMP(6) ELSE consumed_at END
            WHERE id = ?`,
          [row.id]
        );
        await connection.commit();
        throw new Error('Pairing code does not match this WordPress endpoint.');
      }
      await connection.execute(
        'UPDATE pairing_codes SET consumed_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
        [row.id]
      );
      await connection.commit();
      return {
        siteKey: row.requested_site_key,
        label: row.requested_label,
        expectedOrigin: row.expected_origin,
        expectedMcpPath: row.expected_mcp_path,
        environment: row.environment,
        writes: Boolean(row.writes_enabled) && row.environment !== 'live',
      };
    } catch (error) {
      if (connection.connection?._closing !== true) await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async insertAuditEvent(event) {
    // details is constructed from allowlisted fields by the caller. JSON serialization keeps
    // SQL parameterization intact and must never receive request headers or credentials.
    await this.pool.execute(
      `INSERT INTO registry_audit_events
         (event_type, site_id, actor_type, actor_fingerprint, details_json)
       VALUES (?, ?, ?, ?, ?)`,
      [event.eventType, event.siteId || null, event.actorType,
        event.actorFingerprint || null, event.details ? JSON.stringify(event.details) : null]
    );
  }

  /** Insert a fully verified site. Callers must validate the endpoint before activation. */
  async insertActiveSite(site, plaintextCredential) {
    const encrypted = encryptCredential(site, plaintextCredential, this.masterKey);
    await this.pool.execute(
      `INSERT INTO sites (
         id, site_key, label, origin, mcp_path, environment, writes_enabled, status,
         credential_ciphertext, credential_iv, credential_tag, credential_key_version,
         credential_fingerprint, upstream_tools_json, rate_limit_per_minute, timeout_ms,
         last_verified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))`,
      [
        site.id, site.key, site.label, site.origin, site.mcpPath, site.env,
        site.env === 'live' ? false : Boolean(site.writes),
        encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion,
        encrypted.fingerprint,
        site.upstreamTools ? JSON.stringify(site.upstreamTools) : null,
        site.rateLimitPerMin || 30,
        site.timeoutMs || 120000,
      ]
    );
  }

  async deleteSiteForTest(id) {
    // This narrowly scoped helper is used only by the local persistence self-test. Production
    // disconnection will disable and cryptographically erase instead of deleting history.
    await this.pool.execute('DELETE FROM sites WHERE id = ?', [id]);
  }

  async deletePairingsForTest(siteKey) {
    await this.pool.execute('DELETE FROM pairing_codes WHERE requested_site_key = ?', [siteKey]);
  }
}

module.exports = { SiteRepository, runtimeSiteFromRow };
