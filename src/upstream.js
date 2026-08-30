'use strict';

/**
 * Minimal MCP client for one Novamira install, over Streamable HTTP with
 * WordPress Application Password Basic auth. No SDK: the SDK's server/client
 * API has churned across minor versions and this is ~100 lines of JSON-RPC.
 *
 * Upstream tool names are DISCOVERED, not hardcoded. If Novamira renames its
 * adapter tools, matching still works off the name suffix. Override per site
 * with "upstreamTools" in registry.json if you ever need to pin them.
 */

const PROTOCOL_VERSION = '2025-06-18';

// Canonical suffixes we need, in preference order.
const WANTED = {
  discover: ['discover-abilities', 'discover_abilities', 'discoverabilities'],
  info: ['get-ability-info', 'get_ability_info', 'getabilityinfo'],
  execute: ['execute-ability', 'execute_ability', 'executeability'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

class UpstreamError extends Error {}

class Upstream {
  constructor(site) {
    this.site = site;
    this.url = site.base.replace(/\/$/, '') + site.mcpPath;
    this.auth = 'Basic ' + Buffer.from(`${site.user}:${site.password}`).toString('base64');
    this.sessionId = null;
    this.initialized = false;
    this.toolMap = site.upstreamTools ? { ...site.upstreamTools } : null;
    this._inflight = null;
  }

  async _post(body) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: this.auth,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'user-agent': 'indak-wp-gateway/1.0',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.site.timeoutMs);
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
        redirect: 'follow',
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new UpstreamError(`${this.site.label}: timed out after ${this.site.timeoutMs}ms`);
      }
      throw new UpstreamError(`${this.site.label}: could not be reached (${e.message})`);
    } finally {
      clearTimeout(timer);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    // Notifications return 202 with no body.
    if (res.status === 202) return null;

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      throw new UpstreamError(
        `${this.site.label}: WordPress rejected the credentials (HTTP ${res.status}). ` +
        `Check the ${this.site.user} application password and that Novamira's AI abilities are enabled.`
      );
    }
    if (res.status === 404) {
      throw new UpstreamError(
        `${this.site.label}: no MCP endpoint at ${this.site.mcpPath}. ` +
        `Copy the exact path from Novamira > Configuration and set "mcpPath" for this site.`
      );
    }
    if (res.status === 404 || res.status >= 500) {
      throw new UpstreamError(`${this.site.label}: HTTP ${res.status} from WordPress. ${text.slice(0, 300)}`);
    }

    const payload = parseBody(res.headers.get('content-type') || '', text);
    if (!payload) {
      if (!res.ok) throw new UpstreamError(`${this.site.label}: HTTP ${res.status}. ${text.slice(0, 300)}`);
      return null;
    }
    if (payload.error) {
      const m = payload.error.message || JSON.stringify(payload.error);
      throw new UpstreamError(`${this.site.label}: ${m}`);
    }
    return payload.result ?? null;
  }

  async _init() {
    if (this.initialized) return;
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      await this._post({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'indak-wp-gateway', version: '1.0.0' },
        },
      });
      try {
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      } catch { /* older adapters don't care */ }
      this.initialized = true;
    })().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  /** Resolve the three upstream tool names by listing them. */
  async _tools() {
    if (this.toolMap) return this.toolMap;
    await this._init();
    const result = await this._post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (result?.tools || []).map((t) => t.name).filter(Boolean);
    if (!names.length) throw new UpstreamError(`${this.site.label}: exposed no MCP tools.`);

    const map = {};
    for (const [slot, candidates] of Object.entries(WANTED)) {
      const hit = names.find((n) => candidates.some((c) => norm(n).endsWith(norm(c))));
      if (hit) map[slot] = hit;
    }
    const missing = Object.keys(WANTED).filter((k) => !map[k]);
    if (missing.length) {
      throw new UpstreamError(
        `${this.site.label}: could not find upstream tool(s) for ${missing.join(', ')}. ` +
        `Saw: ${names.join(', ')}. Pin them with "upstreamTools" in registry.json.`
      );
    }
    this.toolMap = map;
    return map;
  }

  async call(slot, args) {
    const map = await this._tools();
    await this._init();
    const result = await this._post({
      jsonrpc: '2.0', id: Date.now() % 100000,
      method: 'tools/call',
      params: { name: map[slot], arguments: args || {} },
    });
    // Retry once on a stale session (WP restarts, adapter cache clears).
    return result;
  }

  async callWithRetry(slot, args) {
    try {
      return await this.call(slot, args);
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      if (!/session|initializ/i.test(e.message)) throw e;
      this.sessionId = null;
      this.initialized = false;
      return this.call(slot, args);
    }
  }
}

/** Handles both plain JSON and an SSE-framed single response. */
function parseBody(contentType, text) {
  if (!text) return null;
  if (contentType.includes('text/event-stream')) {
    const lines = text.split(/\r?\n/);
    let last = null;
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (!chunk) continue;
      try {
        const obj = JSON.parse(chunk);
        if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
      } catch { /* keepalive or partial frame */ }
    }
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const pool = new Map();
function upstreamFor(site) {
  const cached = pool.get(site.key);
  if (cached && cached.password === site.password && cached.up.url.startsWith(site.base)) return cached.up;
  const up = new Upstream(site);
  pool.set(site.key, { up, password: site.password });
  return up;
}

module.exports = { Upstream, UpstreamError, upstreamFor, parseBody, PROTOCOL_VERSION };
