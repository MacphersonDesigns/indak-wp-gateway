'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Loads registry.json and resolves each site's WordPress application password
 * from the env var named by appPasswordEnv. Sites without a base URL or
 * without their secret present are skipped, loudly.
 */
function loadRegistry(file) {
  let raw;
  let source;

  // REGISTRY_JSON wins. Hosts that build from a git repo (Hostinger Web Apps,
  // Railway, Fly) should use it: registry.json is gitignored on purpose, so
  // adding a site becomes "edit one env var", with no code push.
  if (process.env.REGISTRY_JSON) {
    source = 'REGISTRY_JSON env var';
    try {
      raw = JSON.parse(process.env.REGISTRY_JSON);
    } catch (e) {
      throw new Error(`REGISTRY_JSON is not valid JSON: ${e.message}`);
    }
  } else {
    const abs = path.resolve(file || process.env.REGISTRY_FILE || 'registry.json');
    if (!fs.existsSync(abs)) {
      throw new Error(
        `No registry found. Either set the REGISTRY_JSON env var (recommended when deploying) ` +
        `or create ${abs} (cp registry.example.json registry.json).`
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
