'use strict';

/**
 * Minimal MCP client for one Novamira install, over Streamable HTTP with either the
 * connector's route-scoped bearer credential (paired sites) or WordPress Application
 * Password Basic auth (legacy SITES entries). No SDK: the SDK's server/client API has
 * churned across minor versions and this is a few hundred lines of JSON-RPC.
 *
 * Upstream tool names are DISCOVERED, not hardcoded. If Novamira renames its
 * adapter tools, matching still works off the name suffix. Override per site
 * with "upstreamTools" in registry.json if you ever need to pin them.
 */

const PROTOCOL_VERSION = '2025-06-18';
const { version: VERSION } = require('../package.json');

// Canonical suffixes we need, in preference order.
const WANTED = {
  discover: ['discover-abilities', 'discover_abilities', 'discoverabilities'],
  info: ['get-ability-info', 'get_ability_info', 'getabilityinfo'],
  execute: ['execute-ability', 'execute_ability', 'executeability'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * kind tells callers what failed:
 *   transport - unreachable, timeout, oversized body
 *   auth      - WordPress rejected the credential
 *   endpoint  - wrong path, redirect, or server error
 *   session   - the upstream MCP session expired; safe to re-initialize and retry
 *   tool      - the upstream tool name is unknown (Novamira renamed its adapter tools)
 *   protocol  - a JSON-RPC error from an otherwise healthy site
 */
class UpstreamError extends Error {
  constructor(message, kind = 'protocol', code = null) {
    super(message);
    this.kind = kind;
    this.code = code;
    // The Mcp-Session-Id the failing request carried (null if none), so a retry only resets
    // that session and never one a concurrent call has just started.
    this.sentSessionId = undefined;
  }
}

// WordPress MCP Adapter error codes (includes/Infrastructure/ErrorHandling/McpErrorFactory.php).
const SESSION_NOT_FOUND = -32005;
const TOOL_NOT_FOUND = -32003;
// Message fallbacks for adapters that use other codes: 0.3-0.4 report an expired session as
// -32602 "Invalid or expired session", and unreleased versions report unknown tools as
// -32602 "Tool not found". Adapter messages can be translated, so codes are checked first.
const SESSION_ERROR = /session/i;
const UNKNOWN_TOOL_ERROR = /(unknown|invalid|no such) tool|tool[^.]*(not found|does not exist|not registered)/i;
// Novamira ends sessions after 4 hours idle (the adapter default is 24). Starting a new
// session before that saves a failed round trip.
const SESSION_IDLE_MS = 3 * 60 * 60 * 1000;

class Upstream {
  constructor(site, hooks = {}) {
    this.site = site;
    this.url = site.base.replace(/\/$/, '') + site.mcpPath;
    // Paired connector sites use a credential that is accepted only on their exact MCP
    // route. Legacy environment sites retain WordPress Application Password Basic auth.
    this.auth = site.authType === 'scoped-bearer'
      ? `Bearer ${site.password}`
      : 'Basic ' + Buffer.from(`${site.user}:${site.password}`).toString('base64');
    this.sessionId = null;
    this.initialized = false;
    this.toolMap = site.upstreamTools ? { ...site.upstreamTools } : null;
    this.onToolsChanged = hooks.onToolsChanged || null;
    // Optional absolute time (ms) by which every request must finish, for callers such as
    // pairing verification that promise WordPress an answer within a fixed time.
    this.deadline = hooks.deadline || null;
    this.lastUsedAt = 0;
    this._gen = 0;
    this._inflight = null;
  }

  /**
   * Forget a session so the next call starts a new one. With staleId, only if that is still
   * the current session: another call may already have replaced it.
   */
  resetSession(staleId) {
    if (staleId !== undefined && staleId !== this.sessionId) return;
    this._gen++;
    this.sessionId = null;
    this.initialized = false;
  }

  async _post(body, { timeoutMs } = {}) {
    const sentSession = this.sessionId;
    try {
      return await this._send(body, sentSession, timeoutMs || this.site.timeoutMs);
    } catch (error) {
      if (error instanceof UpstreamError) error.sentSessionId = sentSession;
      throw error;
    }
  }

  async _send(body, sentSession, requestTimeoutMs) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: this.auth,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'user-agent': `indak-wp-gateway/${VERSION}`,
    };
    if (sentSession) headers['mcp-session-id'] = sentSession;
    const label = this.site.label;
    const timeoutMs = this.deadline
      ? Math.min(requestTimeoutMs, this.deadline - Date.now())
      : requestTimeoutMs;
    if (timeoutMs <= 0) throw new UpstreamError(`${label}: timed out`, 'transport');

    // The timer covers the whole exchange, including reading the body: a site that sends
    // headers and then stalls must not hold the call open forever.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await this._exchange(body, headers, ac.signal, label);
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      if (e.name === 'AbortError' || ac.signal.aborted) {
        throw new UpstreamError(`${label}: timed out after ${timeoutMs}ms`, 'transport');
      }
      throw new UpstreamError(`${label}: could not be reached (${e.message})`, 'transport');
    } finally {
      clearTimeout(timer);
    }
  }

  async _exchange(body, headers, signal, label) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      // An MCP endpoint should not redirect. Following redirects while carrying a site
      // credential could leak it to a different host and would create an SSRF pivot.
      redirect: 'manual',
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    // Notifications return 202 with no body.
    if (res.status === 202) return null;

    if (res.status >= 300 && res.status < 400) {
      throw new UpstreamError(
        `${label}: MCP endpoint redirected (HTTP ${res.status}). ` +
        `Save the final HTTPS endpoint instead of a redirecting URL.`,
        'endpoint'
      );
    }

    const text = await readLimitedBody(res, 5 * 1024 * 1024, label);

    if (res.status === 401 || res.status === 403) {
      throw new UpstreamError(
        this.site.authType === 'scoped-bearer'
          ? `${label}: WordPress rejected the gateway credential (HTTP ${res.status}). ` +
            `The site was probably disconnected in Settings > Indak Gateway, or the Indak Gateway ` +
            `Connector plugin is inactive. Re-pair it from the gateway Site Manager.`
          : `${label}: WordPress rejected the credentials (HTTP ${res.status}). ` +
            `Check the ${this.site.user} application password and that Novamira's AI abilities are enabled.`,
        'auth'
      );
    }
    // Classify by the JSON-RPC error before the HTTP status: the MCP adapter answers 404 both
    // for an ended session (-32005, which the client must answer by re-initializing) and for an
    // unknown tool (-32003), while a missing route is a WordPress rest_no_route 404.
    const payload = parseBody(res.headers.get('content-type') || '', text);
    const rpcError = payload && payload.error && typeof payload.error === 'object' ? payload.error : null;
    const rpcCode = rpcError && Number.isInteger(rpcError.code) ? rpcError.code : null;
    const rpcMessage = rpcError ? String(rpcError.message || JSON.stringify(rpcError)) : '';
    if (rpcCode === SESSION_NOT_FOUND || (rpcError && SESSION_ERROR.test(rpcMessage))) {
      throw new UpstreamError(`${label}: ${rpcMessage}`, 'session', rpcCode);
    }
    if (body.method === 'tools/call' &&
        (rpcCode === TOOL_NOT_FOUND || (rpcError && UNKNOWN_TOOL_ERROR.test(rpcMessage)))) {
      throw new UpstreamError(`${label}: ${rpcMessage}`, 'tool', rpcCode);
    }
    if (res.status === 404) {
      throw new UpstreamError(
        `${label}: no MCP endpoint at ${this.site.mcpPath} (HTTP 404). ` +
        (this.site.authType === 'scoped-bearer'
          ? `Check that Novamira is active on the site, then re-pair it from the Site Manager.`
          : `Copy the exact path from Novamira > Configuration and set "mcpPath" for this site.`),
        'endpoint'
      );
    }
    if (res.status >= 500) {
      throw new UpstreamError(`${label}: HTTP ${res.status} from WordPress. ${text.slice(0, 300)}`, 'endpoint');
    }

    if (!payload) {
      if (!res.ok) throw new UpstreamError(`${label}: HTTP ${res.status}. ${text.slice(0, 300)}`, 'endpoint');
      return null;
    }
    if (rpcError) {
      throw new UpstreamError(
        `${label}: ${rpcMessage}`,
        /not initiali[sz]ed/i.test(rpcMessage) ? 'session' : 'protocol',
        rpcCode
      );
    }
    if (!res.ok) throw new UpstreamError(`${label}: HTTP ${res.status}. ${text.slice(0, 300)}`, 'endpoint');
    return payload.result ?? null;
  }

  async _init() {
    if (this.initialized) return;
    if (this._inflight) return this._inflight;
    const gen = this._gen;
    this._inflight = (async () => {
      await this._post({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'indak-wp-gateway', version: VERSION },
        },
      });
      this.lastUsedAt = Date.now();
      try {
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { timeoutMs: 5000 });
      } catch { /* older adapters don't care */ }
      // A reset while this handshake ran means its session may already be gone.
      if (gen === this._gen) this.initialized = true;
    })().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  /** Resolve the three upstream tool names by listing them. */
  async _tools() {
    if (this.toolMap) return this.toolMap;
    await this._init();
    const result = await this._post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (result?.tools || []).map((t) => t.name).filter(Boolean);
    if (!names.length) throw new UpstreamError(`${this.site.label}: exposed no MCP tools.`, 'endpoint');

    const map = {};
    for (const [slot, candidates] of Object.entries(WANTED)) {
      const hit = names.find((n) => candidates.some((c) => norm(n).endsWith(norm(c))));
      if (hit) map[slot] = hit;
    }
    const missing = Object.keys(WANTED).filter((k) => !map[k]);
    if (missing.length) {
      throw new UpstreamError(
        `${this.site.label}: could not find upstream tool(s) for ${missing.join(', ')}. ` +
        `Saw: ${names.join(', ')}. Pin them with "upstreamTools" in registry.json.`,
        'endpoint'
      );
    }
    this.toolMap = map;
    return map;
  }

  async call(slot, args) {
    if (this.sessionId && !this._inflight && Date.now() - this.lastUsedAt > SESSION_IDLE_MS) {
      this.resetSession(this.sessionId);
    }
    const map = await this._tools();
    await this._init();
    try {
      const result = await this._post({
        jsonrpc: '2.0', id: Date.now() % 100000,
        method: 'tools/call',
        params: { name: map[slot], arguments: args || {} },
      });
      this.lastUsedAt = Date.now();
      return result;
    } catch (error) {
      if (error instanceof UpstreamError) error.sentTool = map[slot];
      throw error;
    }
  }

  /**
   * Retry once after an expired session (WordPress restarts, adapter session cleanup) and
   * once after a Novamira update renames its adapter tools. Before these retries, either
   * failure stuck until the gateway restarted or the site was re-paired.
   */
  async callWithRetry(slot, args) {
    try {
      return await this.call(slot, args);
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      if (e.kind === 'session') {
        this.resetSession(e.sentSessionId);
        return this.call(slot, args);
      }
      if (e.kind === 'tool') {
        // Compare with the name this call actually sent: a concurrent call may already have
        // rediscovered the new names, in which case a plain retry is enough.
        const sent = e.sentTool;
        if (this.toolMap && this.toolMap[slot] && this.toolMap[slot] !== sent) return this.call(slot, args);
        this.toolMap = null;
        const map = await this._tools();
        if (!map[slot] || map[slot] === sent) throw e;
        if (this.onToolsChanged) this.onToolsChanged({ ...map });
        return this.call(slot, args);
      }
      throw e;
    }
  }
}

async function readLimitedBody(res, limit, label) {
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) {
      // Cancel the remaining body so a malicious upstream cannot keep the connection busy.
      await res.body.cancel().catch(() => {});
      throw new UpstreamError(`${label}: upstream response exceeded ${limit} bytes.`, 'transport');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
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
function upstreamFor(site, hooks = {}) {
  const url = site.base.replace(/\/$/, '') + site.mcpPath;
  const cached = pool.get(site.key);
  if (cached && cached.password === site.password && cached.up.url === url) {
    cached.up.site = site;
    if (hooks.onToolsChanged) cached.up.onToolsChanged = hooks.onToolsChanged;
    return cached.up;
  }
  const up = new Upstream(site, hooks);
  pool.set(site.key, { up, password: site.password });
  return up;
}

/** Forget a cached client so the next call starts a fresh session with current settings. */
function dropUpstream(siteKey) {
  pool.delete(siteKey);
}

module.exports = { Upstream, UpstreamError, upstreamFor, dropUpstream, parseBody, readLimitedBody, PROTOCOL_VERSION };
