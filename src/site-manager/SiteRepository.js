'use strict';

const { decryptCredential, encryptCredential } = require('./CredentialCipher');
const { PairingError, PairingConflictError } = require('./errors');

const RUNTIME_COLUMNS = `id, site_key, label, origin, mcp_path, environment, writes_enabled,
  credential_ciphertext, credential_iv, credential_tag, credential_key_version,
  upstream_tools_json, rate_limit_per_minute, timeout_ms`;

const ADMIN_COLUMNS = `id, site_key, label, origin, mcp_path, environment, writes_enabled, status,
  credential_fingerprint, last_verified_at, last_error, created_at, updated_at`;

const MAX_ERROR_LENGTH = 500;

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

function sameEndpoint(row, origin, mcpPath) {
  return row.origin === origin && row.mcp_path === mcpPath;
}

/**
 * Decide how a pairing for (siteKey, origin + mcpPath) relates to rows that already exist.
 *
 * Re-pairing the same key and endpoint replaces the old credential in place. That is the
 * normal recovery path: a site disconnected only on the WordPress side, or a pairing whose
 * WordPress request timed out, must never require deleting rows by hand. A removed
 * (disabled) row never blocks a new pairing. Only a different, still-active site holding the
 * key or the endpoint is a conflict, because replacing it would silently reroute the team.
 */
function planPairing(rows, siteKey, origin, mcpPath) {
  const byKey = rows.find((row) => row.site_key === siteKey) || null;
  const byEndpoint = rows.find((row) => sameEndpoint(row, origin, mcpPath)) || null;
  if (byKey && byKey.status === 'active' && !sameEndpoint(byKey, origin, mcpPath)) {
    throw new PairingConflictError(
      `Site key "${siteKey}" is already connected to ${byKey.origin}${byKey.mcp_path}. ` +
      'Remove that site in the Site Manager first, or choose a different key.'
    );
  }
  if (byEndpoint && byEndpoint.site_key !== siteKey && byEndpoint.status === 'active') {
    throw new PairingConflictError(
      `That WordPress site is already connected as "${byEndpoint.site_key}". ` +
      'Re-pair it with that key, or remove it in the Site Manager first.'
    );
  }
  // Reuse the row only for the same key. A removed row under another key keeps its key as a
  // tombstone (so an old SITES line with that key stays blocked); it is only moved off the
  // endpoint's unique slot so the new pairing can take it.
  const target = byKey;
  const retire = byEndpoint && (!byKey || byKey.id !== byEndpoint.id) ? byEndpoint : null;
  return { target, retire };
}

class SiteRepository {
  constructor(pool, masterKey) {
    this.pool = pool;
    this.masterKey = masterKey;
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  decryptRow(row) {
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
    return runtimeSiteFromRow(row, credential);
  }

  /**
   * Routable paired sites, plus the keys of removed sites. A removed key is a tombstone: it
   * keeps an old SITES line with the same key from quietly taking over the route.
   */
  async listActiveSites() {
    const [rows] = await this.pool.execute(
      `SELECT ${RUNTIME_COLUMNS} FROM sites WHERE status = 'active' ORDER BY site_key`
    );
    const [removed] = await this.pool.execute(
      `SELECT site_key FROM sites WHERE status = 'disabled'`
    );
    const sites = {};
    const skipped = [];
    for (const row of rows) {
      try {
        sites[row.site_key] = this.decryptRow(row);
      } catch (error) {
        skipped.push({ key: row.site_key, why: `database credential could not be loaded: ${error.message}` });
      }
    }
    return { sites, skipped, removedKeys: removed.map((row) => row.site_key) };
  }

  /** One active site with its decrypted credential, or null when it is not active. */
  async activeSiteByKey(siteKey) {
    const [rows] = await this.pool.execute(
      `SELECT ${RUNTIME_COLUMNS} FROM sites WHERE site_key = ? AND status = 'active' LIMIT 1`,
      [siteKey]
    );
    return rows[0] ? this.decryptRow(rows[0]) : null;
  }

  async listSitesForAdmin() {
    let rows;
    try {
      [rows] = await this.pool.execute(
        `SELECT ${ADMIN_COLUMNS}, connector_version FROM sites ORDER BY label, site_key`
      );
    } catch (error) {
      // Tolerate a database where migration 002 has not been applied yet.
      if (error.code !== 'ER_BAD_FIELD_ERROR') throw error;
      [rows] = await this.pool.execute(`SELECT ${ADMIN_COLUMNS} FROM sites ORDER BY label, site_key`);
    }
    return rows.map((row) => ({
      id: row.id,
      site_key: row.site_key,
      label: row.label,
      mcp_url: row.origin + row.mcp_path,
      environment: row.environment,
      writes: Boolean(row.writes_enabled),
      status: row.status,
      connector_version: row.connector_version || null,
      credential_fingerprint: row.credential_fingerprint,
      last_verified_at: row.last_verified_at,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  /** Non-locking preview used when a manager creates a code, so conflicts surface early. */
  async previewPairing(siteKey, origin, mcpPath) {
    const [rows] = await this.pool.execute(
      `SELECT id, site_key, label, origin, mcp_path, status FROM sites
        WHERE site_key = ? OR (origin = ? AND mcp_path = ?)`,
      [siteKey, origin, mcpPath]
    );
    const { target } = planPairing(rows, siteKey, origin, mcpPath);
    return target && target.status === 'active'
      ? { site_key: target.site_key, label: target.label }
      : null;
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
      throw new PairingError('Pairing code is invalid or expired. Create a new code in the Site Manager.');
    }
    if (row.expected_origin !== origin) {
      throw new PairingError(
        `Pairing code does not match this WordPress site. It was created for ${row.expected_origin}.`
      );
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
    return this.withTransaction(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, expected_origin, expected_mcp_path, requested_site_key, requested_label,
                environment, writes_enabled, failed_attempts, expires_at, consumed_at
           FROM pairing_codes WHERE code_digest = ? FOR UPDATE`,
        [digest]
      );
      const row = rows[0];
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) {
        throw new PairingError('Pairing code is invalid or expired. Create a new code in the Site Manager.');
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
        throw new PairingError('Pairing code does not match this WordPress endpoint.');
      }
      await connection.execute(
        'UPDATE pairing_codes SET consumed_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
        [row.id]
      );
      return {
        siteKey: row.requested_site_key,
        label: row.requested_label,
        expectedOrigin: row.expected_origin,
        expectedMcpPath: row.expected_mcp_path,
        environment: row.environment,
        writes: Boolean(row.writes_enabled) && row.environment !== 'live',
      };
    });
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

  /**
   * Activate a verified site, replacing any earlier row for the same key or endpoint.
   * Callers must validate the endpoint with the new credential before calling this.
   */
  async upsertPairedSite(site, plaintextCredential) {
    return this.withTransaction(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, site_key, label, origin, mcp_path, status FROM sites
          WHERE site_key = ? OR (origin = ? AND mcp_path = ?) FOR UPDATE`,
        [site.key, site.origin, site.mcpPath]
      );
      const { target, retire } = planPairing(rows, site.key, site.origin, site.mcpPath);
      if (retire) {
        await connection.execute(
          `UPDATE sites SET mcp_path = CONCAT(LEFT(mcp_path, 400), '#retired-', id), updated_at = updated_at
            WHERE id = ?`,
          [retire.id]
        );
      }

      // The row id is part of the ciphertext's authenticated data, so encrypt only once the
      // final id is known.
      const id = target ? target.id : site.id;
      const encrypted = encryptCredential(
        { id, origin: site.origin, mcpPath: site.mcpPath }, plaintextCredential, this.masterKey
      );
      const writes = site.env === 'live' ? false : Boolean(site.writes);
      const tools = site.upstreamTools ? JSON.stringify(site.upstreamTools) : null;

      if (target) {
        await connection.execute(
          `UPDATE sites
              SET site_key = ?, label = ?, origin = ?, mcp_path = ?, environment = ?,
                  writes_enabled = ?, status = 'active',
                  credential_ciphertext = ?, credential_iv = ?, credential_tag = ?,
                  credential_key_version = ?, credential_fingerprint = ?, upstream_tools_json = ?,
                  last_verified_at = CURRENT_TIMESTAMP(6), last_error = NULL
            WHERE id = ?`,
          [site.key, site.label, site.origin, site.mcpPath, site.env, writes,
            encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion,
            encrypted.fingerprint, tools, id]
        );
      } else {
        await connection.execute(
          `INSERT INTO sites (
             id, site_key, label, origin, mcp_path, environment, writes_enabled, status,
             credential_ciphertext, credential_iv, credential_tag, credential_key_version,
             credential_fingerprint, upstream_tools_json, rate_limit_per_minute, timeout_ms,
             last_verified_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))`,
          [id, site.key, site.label, site.origin, site.mcpPath, site.env, writes,
            encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion,
            encrypted.fingerprint, tools, site.rateLimitPerMin || 30, site.timeoutMs || 120000]
        );
      }
      return {
        id,
        replaced: target ? { site_key: target.site_key, status: target.status } : null,
        retiredId: retire ? retire.id : null,
      };
    });
  }

  /** @deprecated Kept for the persistence self-test; pairing uses upsertPairedSite. */
  async insertActiveSite(site, plaintextCredential) {
    await this.upsertPairedSite(site, plaintextCredential);
  }

  /**
   * Remove a site from routing. The row stays for history, but its encrypted credential is
   * erased so the gateway can never call that WordPress site again without a new pairing.
   */
  async disableSite(id, reason) {
    const [result] = await this.pool.execute(
      `UPDATE sites
          SET status = 'disabled', credential_ciphertext = NULL, credential_iv = NULL,
              credential_tag = NULL, credential_fingerprint = NULL, last_error = ?
        WHERE id = ? AND status <> 'disabled'`,
      [String(reason || '').slice(0, MAX_ERROR_LENGTH), id]
    );
    return result.affectedRows > 0;
  }

  async siteSummaryByKey(siteKey) {
    const [rows] = await this.pool.execute(
      `SELECT ${ADMIN_COLUMNS} FROM sites WHERE site_key = ? LIMIT 1`,
      [siteKey]
    );
    return rows[0] || null;
  }

  async recordCheck(id, { ok, error = null, upstreamTools = null }) {
    if (ok) {
      await this.pool.execute(
        `UPDATE sites
            SET last_verified_at = CURRENT_TIMESTAMP(6), last_error = NULL,
                upstream_tools_json = COALESCE(?, upstream_tools_json)
          WHERE id = ? AND status = 'active'`,
        [upstreamTools ? JSON.stringify(upstreamTools) : null, id]
      );
      return;
    }
    // updated_at is set explicitly: MySQL skips ON UPDATE when a repeated failure writes the
    // same message, and the Site Manager shows this time as "Failed <time>".
    await this.pool.execute(
      `UPDATE sites SET last_error = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND status = 'active'`,
      [String(error || 'Unknown error').slice(0, MAX_ERROR_LENGTH), id]
    );
  }

  /** Best effort: older databases without migration 002 simply skip this. */
  async recordConnectorVersion(id, version) {
    const value = String(version || '').trim().slice(0, 32);
    if (!value) return;
    try {
      // updated_at is kept as is: the Site Manager shows it as the time of the last failure,
      // and a version report is not a check.
      await this.pool.execute(
        'UPDATE sites SET connector_version = ?, updated_at = updated_at WHERE id = ? AND NOT (connector_version <=> ?)',
        [value, id, value]
      );
    } catch (error) {
      if (error.code !== 'ER_BAD_FIELD_ERROR') throw error;
    }
  }

  async withTransaction(work) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (connection.connection?._closing !== true) await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteSiteForTest(id) {
    // This narrowly scoped helper is used only by the local persistence self-tests. Production
    // removal disables and cryptographically erases instead of deleting history.
    await this.pool.execute('DELETE FROM sites WHERE id = ?', [id]);
  }

  async deletePairingsForTest(siteKey) {
    await this.pool.execute('DELETE FROM pairing_codes WHERE requested_site_key = ?', [siteKey]);
  }
}

module.exports = { SiteRepository, PairingConflictError, planPairing, runtimeSiteFromRow };
