'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Loads registry.json and resolves each site's WordPress application password
 * from the env var named by appPasswordEnv. Sites without a base URL or
 * without their secret present are skipped, loudly.
 */
/**
 * Some hosts (Hostinger's env var editor among them) escape quotes and braces when
 * you paste JSON, so the value arrives as \{"key"... and JSON.parse chokes. Undo the
 * common manglings rather than making the user fight the panel.
 */
function unmangle(raw) {
  let v = String(raw).trim();
  // A value wrapped in quotes by the panel.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  // Backslashes in front of JSON punctuation are never valid JSON, so they are always
  // escaping added by the host.
  if (/\\[{}"\[\]:,]/.test(v)) v = v.replace(/\\([{}"\[\]:,])/g, '$1');
  // Smart quotes, courtesy of anyone who round-tripped this through a doc.
  v = v.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  return v;
}

/**
 * SITES: an escape-proof alternative to REGISTRY_JSON for panels that mangle quotes.
 * One site per line (or separated by ";"), pipe-delimited:
 *
 *   key | Label | https://url | live|staging | writes(true/false)
 *
 * env and writes are optional: env is guessed from the URL, and writes defaults to
 * true on staging and false on live.
 */
function parseSites(raw) {
  const out = {};
  const rows = String(raw).split(/[\n;]+/).map((r) => r.trim()).filter(Boolean);
  for (const row of rows) {
    const parts = row.split('|').map((x) => x.trim());
    const [key, label, base] = parts;
    if (!key || !base) throw new Error(`SITES row needs at least "key | Label | https://url", got: ${row}`);
    let env = (parts[3] || '').toLowerCase();
    if (env !== 'live' && env !== 'staging') env = /staging|dev\.|test\./i.test(base) ? 'staging' : 'live';
    const writesRaw = (parts[4] || '').toLowerCase();
    const writes = writesRaw ? writesRaw === 'true' || writesRaw === 'yes' : env === 'staging';
    out[key.toLowerCase()] = { label: label || key, base, env, writes };
  }
  if (!Object.keys(out).length) throw new Error('SITES was set but contained no rows.');
  return out;
}

function loadRegistry(file) {
  let raw;
  let source;

  // Precedence: SITES (simplest) -> REGISTRY_B64 -> REGISTRY_JSON -> registry.json file.
  if (process.env.SITES) {
    source = 'SITES env var';
    raw = parseSites(process.env.SITES);
  } else if (process.env.REGISTRY_B64) {
    source = 'REGISTRY_B64 env var';
    let decoded;
    try {
      decoded = Buffer.from(process.env.REGISTRY_B64.trim(), 'base64').toString('utf8');
    } catch (e) {
      throw new Error(`REGISTRY_B64 is not valid base64: ${e.message}`);
    }
    try {
      raw = JSON.parse(decoded);
    } catch (e) {
      throw new Error(`REGISTRY_B64 decoded to something that is not JSON: ${e.message}`);
    }
  } else if (process.env.REGISTRY_JSON) {
    source = 'REGISTRY_JSON env var';
    const cleaned = unmangle(process.env.REGISTRY_JSON);
    try {
      raw = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(
        `REGISTRY_JSON is not valid JSON: ${e.message}. ` +
        `If your hosting panel added backslashes, use the SITES variable instead: ` +
        `SITES=key | Label | https://url | staging`
      );
    }
  } else {
    const abs = path.resolve(file || process.env.REGISTRY_FILE || 'registry.json');
    if (!fs.existsSync(abs)) {
      throw new Error(
        `No site registry configured. Set the SITES env var (simplest) or REGISTRY_JSON, ` +
        `or create ${abs} locally.`
      );
    }
    source = abs;
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      throw new Error(`${abs} is not valid JSON: ${e.message}`);
    }
  }

  const sites = {};
  const skipped = [];

  for (const [key, cfg] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      skipped.push({ key, why: 'site key must be lowercase letters, digits and dashes' });
      continue;
    }
    if (cfg && cfg.disabled === true) {
      skipped.push({ key, why: 'disabled in registry' });
      continue;
    }
    if (!cfg || !cfg.base) {
      skipped.push({ key, why: 'no base URL yet' });
      continue;
    }

    let base;
    try {
      base = new URL(cfg.base);
    } catch {
      skipped.push({ key, why: `base is not a URL: ${cfg.base}` });
      continue;
    }
    if (base.protocol !== 'https:' && process.env.ALLOW_INSECURE_UPSTREAM !== 'true') {
      skipped.push({ key, why: 'base must be https (set ALLOW_INSECURE_UPSTREAM=true for local testing)' });
      continue;
    }

    const envName = cfg.appPasswordEnv || `WP_PW_${key.toUpperCase().replace(/-/g, '_')}`;
    const password = process.env[envName];
    if (!password) {
      skipped.push({ key, why: `missing secret in env: ${envName}` });
      continue;
    }

    const env = cfg.env === 'live' ? 'live' : cfg.env === 'staging' ? 'staging' : 'unknown';
    if (env === 'unknown') {
      skipped.push({ key, why: 'env must be "live" or "staging" so the live-root block can apply' });
      continue;
    }

    sites[key] = {
      key,
      label: cfg.label || key,
      base: base.origin,
      mcpPath: cfg.mcpPath || '/wp-json/mcp-adapter/mcp',
      user: cfg.user || 'novamira-bot',
      password,
      writes: cfg.writes === true,
      env,
      rateLimitPerMin: Number(cfg.rateLimitPerMin) > 0 ? Number(cfg.rateLimitPerMin) : 30,
      upstreamTools: cfg.upstreamTools || null,
      timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 120000,
    };
  }

  return { sites, skipped, file: source };
}

module.exports = { loadRegistry };
