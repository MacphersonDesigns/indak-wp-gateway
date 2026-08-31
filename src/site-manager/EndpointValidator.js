'use strict';

const dns = require('dns').promises;
const net = require('net');

function normalizeMcpUrl(input, { allowInsecure = false } = {}) {
  let url;
  try {
    url = new URL(String(input || ''));
  } catch {
    throw new Error('MCP URL must be a complete URL.');
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new Error('MCP URL must use HTTPS.');
  }
  if (url.username || url.password) throw new Error('MCP URL must not contain credentials.');
  if (url.search || url.hash) throw new Error('MCP URL must not contain a query string or fragment.');
  if (!url.pathname || url.pathname === '/') throw new Error('MCP URL must include the Novamira endpoint path.');
  return {
    origin: url.origin,
    mcpPath: url.pathname.replace(/\/+$/, '') || '/',
    url: url.origin + (url.pathname.replace(/\/+$/, '') || '/'),
    hostname: url.hostname,
  };
}

function privateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] >= 224);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      return privateAddress(normalized.slice('::ffff:'.length));
    }
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') || normalized.startsWith('fea') ||
      normalized.startsWith('feb');
  }
  return true;
}

async function assertPublicEndpoint(normalized, { allowPrivate = false } = {}) {
  const addresses = await dns.lookup(normalized.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('MCP hostname did not resolve.');
  if (!allowPrivate) {
    const blocked = addresses.find((entry) => privateAddress(entry.address));
    if (blocked) throw new Error('MCP hostname resolves to a private or reserved address.');
  }
  return addresses.map((entry) => entry.address);
}

function normalizeSiteKey(input) {
  const key = String(input || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) {
    throw new Error('site_key must use lowercase letters, numbers, and dashes (maximum 80).');
  }
  return key;
}

module.exports = { normalizeMcpUrl, privateAddress, assertPublicEndpoint, normalizeSiteKey };
