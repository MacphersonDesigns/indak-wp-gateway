'use strict';

const tokenInput = document.querySelector('#admin-token');
const manager = document.querySelector('#manager');
const statusRegion = document.querySelector('#status');
const sitesBody = document.querySelector('#sites-body');
const emptySites = document.querySelector('#empty-sites');
const environment = document.querySelector('#environment');
const writes = document.querySelector('#writes');
const pairingResult = document.querySelector('#pairing-result');
const pairingCode = document.querySelector('#pairing-code');

let adminToken = sessionStorage.getItem('indak_gateway_admin_token') || '';
tokenInput.value = adminToken;

function status(message, error = false) {
  statusRegion.textContent = message;
  statusRegion.classList.toggle('error', error);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}.`);
  return body;
}

async function loadSites() {
  adminToken = tokenInput.value.trim();
  if (!adminToken) return status('Enter the gateway admin token.', true);
  status('Loading registered sites…');
  try {
    const body = await api('/admin/sites');
    sessionStorage.setItem('indak_gateway_admin_token', adminToken);
    manager.hidden = false;
    sitesBody.replaceChildren();
    for (const site of body.sites) {
      const row = document.createElement('tr');
      const values = [
        `${site.label} (${site.site_key})`,
        site.environment,
        site.status,
        site.mcp_url,
        site.last_verified_at ? new Date(site.last_verified_at).toLocaleString() : 'Not yet',
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      sitesBody.append(row);
    }
    emptySites.hidden = body.sites.length > 0;
    status(`Loaded ${body.sites.length} paired site${body.sites.length === 1 ? '' : 's'}.`);
  } catch (error) {
    manager.hidden = true;
    status(error.message, true);
  }
}

document.querySelector('#load-sites').addEventListener('click', loadSites);
document.querySelector('#refresh-sites').addEventListener('click', loadSites);

environment.addEventListener('change', () => {
  if (environment.value === 'live') {
    writes.checked = false;
    writes.disabled = true;
  } else {
    writes.disabled = false;
    writes.checked = true;
  }
});

document.querySelector('#pairing-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  pairingResult.hidden = true;
  status('Validating the endpoint and creating a one-time code…');
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/admin/pairing-codes', {
      method: 'POST',
      body: JSON.stringify({
        mcp_url: form.get('mcp_url'),
        site_key: form.get('site_key'),
        label: form.get('label'),
        environment: form.get('environment'),
        writes: form.get('environment') === 'staging' && form.has('writes'),
      }),
    });
    pairingCode.textContent = result.code;
    document.querySelector('#pairing-expiry').textContent = `Expires ${new Date(result.expires_at).toLocaleString()}.`;
    pairingResult.hidden = false;
    pairingResult.focus();
    status('Pairing code created. Paste it into the WordPress connector now.');
  } catch (error) {
    status(error.message, true);
  }
});

document.querySelector('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pairingCode.textContent);
    status('Pairing code copied.');
  } catch {
    status('Copy failed. Select the pairing code and copy it manually.', true);
  }
});

if (adminToken) loadSites();
