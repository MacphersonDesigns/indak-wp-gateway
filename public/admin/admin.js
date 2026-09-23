'use strict';

const $ = (selector) => document.querySelector(selector);

const accessForm = $('#access-form');
const tokenInput = $('#admin-token');
const manager = $('#manager');
const statusRegion = $('#status');
const alertRegion = $('#alert');
const pairingForm = $('#pairing-form');
const createButton = $('#create-code');
const siteUrlInput = $('#mcp-url');
const siteKeyInput = $('#site-key');
const labelInput = $('#label');
const environment = $('#environment');
const writes = $('#writes');
const pairingResult = $('#pairing-result');
const pairingHeading = $('#pairing-heading');
const pairingCode = $('#pairing-code');
const connectorLink = $('#connector-link');
const sitesHeading = $('#sites-heading');
const sitesTable = $('#sites-table');
const sitesBody = $('#sites-body');
const emptySites = $('#empty-sites');
const removeDialog = $('#remove-dialog');
const removeError = $('#remove-dialog-error');
const removeConfirm = $('#remove-confirm');

const TOKEN_KEY = 'indak_gateway_admin_token';
let adminToken = '';
let sitesByKey = new Map();
let lastConnectUrl = '';
let removeTarget = null;
let creating = false;

try {
  adminToken = sessionStorage.getItem(TOKEN_KEY) || '';
} catch {
  adminToken = '';
}
tokenInput.value = adminToken;

// ------------------------------------------------------------ announcements
// Clear, then set after a tick, so repeating the same message is announced again.
let announceTimer;
function announce(message, { error = false } = {}) {
  clearTimeout(announceTimer);
  statusRegion.textContent = '';
  alertRegion.textContent = '';
  const target = error ? alertRegion : statusRegion;
  announceTimer = setTimeout(() => {
    target.textContent = error ? `Error: ${message}` : message;
  }, 50);
}

// Busy buttons stay focusable: `disabled` would drop keyboard focus to <body>.
function setBusy(button, busyText) {
  const text = button.querySelector('.btn-text');
  if (busyText) {
    button.dataset.idleText = text.textContent;
    text.textContent = busyText;
    button.setAttribute('aria-disabled', 'true');
  } else {
    if (button.dataset.idleText) text.textContent = button.dataset.idleText;
    button.removeAttribute('aria-disabled');
  }
}
const isBusy = (button) => button.getAttribute('aria-disabled') === 'true';

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
  if (!response.ok) {
    const error = new Error(body.error || `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// ---------------------------------------------------------------- formatting
function formatTime(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function timeElement(iso) {
  const time = document.createElement('time');
  time.dateTime = new Date(iso).toISOString();
  time.textContent = formatTime(iso);
  return time;
}

function siteAddress(mcpUrl) {
  try {
    const url = new URL(mcpUrl);
    const at = url.pathname.indexOf('/wp-json');
    return url.host + (at > 0 ? url.pathname.slice(0, at) : '');
  } catch {
    return mcpUrl;
  }
}

function siteState(site) {
  if (site.status === 'disabled') return { text: 'Removed', glyph: '–', className: 'is-removed' };
  if (site.status !== 'active' || site.last_error) return { text: 'Error', glyph: '!', className: 'is-error' };
  return { text: 'Active', glyph: '✓', className: 'is-active' };
}

function environmentText(site) {
  if (site.environment === 'live') return 'Live, read-only';
  return site.writes ? 'Staging, writes allowed' : 'Staging, read-only';
}

// ------------------------------------------------------------------- rows
function actionButton(action, text, accessibleSuffix, className = 'secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  const visible = document.createElement('span');
  visible.className = 'btn-text';
  visible.textContent = text;
  const hidden = document.createElement('span');
  hidden.className = 'screen-reader-text';
  hidden.textContent = ` ${accessibleSuffix}`;
  button.append(visible, hidden);
  return button;
}

function fillStatusCell(cell, site) {
  const state = siteState(site);
  const wrapper = document.createElement('span');
  wrapper.className = `site-status ${state.className}`;
  const glyph = document.createElement('span');
  glyph.className = 'status-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = state.glyph;
  wrapper.append(glyph, ` ${state.text}`);
  cell.replaceChildren(wrapper);
}

function fillLastCheckCell(cell, site) {
  cell.replaceChildren();
  if (site.status === 'disabled') {
    cell.append('Removed ');
    if (site.updated_at) cell.append(timeElement(site.updated_at));
    if (site.last_error) cell.append(`: ${site.last_error}`);
    return;
  }
  if (site.last_error) {
    cell.append('Failed ');
    if (site.updated_at) cell.append(timeElement(site.updated_at));
    cell.append(`: ${site.last_error}`);
    return;
  }
  if (site.last_verified_at) {
    cell.append('Verified ', timeElement(site.last_verified_at));
    return;
  }
  cell.textContent = 'Not checked yet';
}

function fillRow(row, site, suffix) {
  const [header, env, status, version, lastCheck, actions] = row.children;

  const label = document.createElement('span');
  label.className = 'site-label';
  label.textContent = site.label;
  const key = document.createElement('span');
  key.className = 'site-key';
  key.textContent = ` (${site.site_key})`;
  const address = document.createElement('span');
  address.className = 'site-url';
  address.textContent = siteAddress(site.mcp_url);
  header.replaceChildren(label, key, address);

  env.textContent = environmentText(site);
  fillStatusCell(status, site);
  version.textContent = versionText(site);
  fillLastCheckCell(lastCheck, site);

  const group = document.createElement('div');
  group.className = 'row-actions';
  if (site.status === 'disabled') {
    group.append(actionButton('repair', 'Pair again', suffix));
  } else {
    group.append(
      actionButton('test', 'Test', suffix),
      actionButton('repair', 'Pair again', suffix),
      actionButton('remove', 'Remove', suffix, 'danger')
    );
  }
  actions.replaceChildren(group);
}

function renderSites(sites) {
  sitesByKey = new Map(sites.map((site) => [site.site_key, site]));
  const labelCounts = new Map();
  for (const site of sites) labelCounts.set(site.label, (labelCounts.get(site.label) || 0) + 1);

  sitesBody.replaceChildren();
  for (const site of sites) {
    const row = document.createElement('tr');
    row.dataset.siteKey = site.site_key;
    const header = document.createElement('th');
    header.scope = 'row';
    row.append(header);
    for (let i = 0; i < 5; i++) row.append(document.createElement('td'));
    row.children[4].className = 'last-check';
    const suffix = labelCounts.get(site.label) > 1 ? `${site.label} (${site.site_key})` : site.label;
    fillRow(row, site, suffix);
    sitesBody.append(row);
  }
  sitesTable.hidden = sites.length === 0;
  emptySites.hidden = sites.length > 0;
}

function rowFor(key) {
  return sitesBody.querySelector(`tr[data-site-key="${CSS.escape(key)}"]`);
}

function focusRowAction(key, action) {
  const target = rowFor(key)?.querySelector(`button[data-action="${action}"]`) || sitesHeading;
  target.focus();
}

// --------------------------------------------------------------- loading
// With announceErrors false the caller reports the failure itself, in one message, so two
// announcements never race and cancel each other.
async function loadSites({ quiet = false, announceErrors = true } = {}) {
  try {
    const body = await api('/admin/sites');
    try {
      sessionStorage.setItem(TOKEN_KEY, adminToken);
    } catch {
      // Storage can be unavailable (private mode); the page still works for this visit.
    }
    manager.hidden = false;
    renderSites(body.sites);
    if (!quiet) announce(`Loaded ${body.sites.length} paired site${body.sites.length === 1 ? '' : 's'}.`);
    return body.sites;
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      manager.hidden = true;
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        // Nothing stored.
      }
      tokenInput.focus();
    }
    if (announceErrors) announce(error.message, { error: true });
    return null;
  }
}

accessForm.addEventListener('submit', (event) => {
  event.preventDefault();
  adminToken = tokenInput.value.trim();
  if (!adminToken) {
    announce('Enter the gateway admin token.', { error: true });
    tokenInput.focus();
    return;
  }
  announce('Loading paired sites…');
  loadSites();
});

$('#refresh-sites').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (isBusy(button)) return;
  setBusy(button, 'Refreshing…');
  await loadSites();
  setBusy(button, null);
});

environment.addEventListener('change', () => {
  if (environment.value === 'live') {
    writes.checked = false;
    writes.disabled = true;
  } else {
    writes.disabled = false;
    writes.checked = true;
  }
});

// ------------------------------------------------------------ pairing codes
pairingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (creating) return;
  creating = true;
  setBusy(createButton, 'Creating code…');
  pairingResult.hidden = true;
  const form = new FormData(pairingForm);
  const label = String(form.get('label') || '').trim();
  try {
    const result = await api('/admin/pairing-codes', {
      method: 'POST',
      body: JSON.stringify({
        mcp_url: form.get('mcp_url'),
        site_key: form.get('site_key'),
        label,
        environment: form.get('environment'),
        writes: form.get('environment') === 'staging' && form.has('writes'),
      }),
    });

    const expires = new Date(result.expires_at);
    const minutes = Math.max(1, Math.round((expires.getTime() - Date.now()) / 60000));
    $('#pairing-site-label').textContent = result.label || label;
    pairingCode.textContent = result.code;
    $('#pairing-expiry').textContent =
      `Expires in ${minutes} minute${minutes === 1 ? '' : 's'}, at ${expires.toLocaleTimeString([], { timeStyle: 'short' })}.`;
    const replaces = $('#pairing-replaces');
    replaces.hidden = !result.replaces;
    if (result.replaces) $('#pairing-replaces-label').textContent = result.replaces.label;
    connectorLink.href = result.connect_url;
    $('#connector-host').textContent = siteAddress(result.mcp_url);
    lastConnectUrl = result.connect_url;

    pairingResult.hidden = false;
    pairingHeading.focus();
    announce(
      `Pairing code created for ${result.label || label}. It expires at ${expires.toLocaleTimeString([], { timeStyle: 'short' })}.` +
      (result.replaces ? ` This will replace the existing connection for ${result.replaces.label}.` : '')
    );
  } catch (error) {
    announce(error.message, { error: true });
  } finally {
    creating = false;
    setBusy(createButton, null);
  }
});

async function copyText(value, success, failure) {
  try {
    await navigator.clipboard.writeText(value);
    announce(success);
  } catch {
    announce(failure, { error: true });
  }
}

$('#copy-code').addEventListener('click', () => copyText(
  pairingCode.textContent,
  'Pairing code copied.',
  'Copy failed. Select the pairing code and copy it manually.'
));

$('#copy-link').addEventListener('click', () => copyText(
  lastConnectUrl,
  'Connect link copied.',
  'Copy failed. Use the Open the connector link instead.'
));

// ------------------------------------------------------------- row actions
function versionText(site) {
  return site.connector_version && site.connector_version !== 'unknown' ? site.connector_version : 'Not reported';
}

async function testSite(key, button) {
  const site = sitesByKey.get(key);
  if (!site || isBusy(button)) return;
  setBusy(button, 'Testing…');
  const cell = rowFor(key)?.querySelector('.last-check');
  if (cell) cell.textContent = 'Testing…';
  announce(`Testing ${site.label}. This can take up to 30 seconds.`);

  let result;
  try {
    result = await api(`/admin/sites/${encodeURIComponent(key)}/verify`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    if (error.status === 404) {
      // Removed or disconnected since this page loaded: show the row as it is now. Its Test
      // button disappears, so focus moves to Pair again instead of falling to the page.
      const sites = await loadSites({ quiet: true, announceErrors: false });
      if (sites) {
        focusRowAction(key, 'repair');
        announce(`${site.label} is no longer connected. ${error.message}`, { error: true });
      } else {
        const row = rowFor(key);
        if (row) fillLastCheckCell(row.children[4], sitesByKey.get(key));
        announce(`${site.label} is no longer connected (${error.message}), but the list could not be refreshed. Choose Refresh sites.`, { error: true });
      }
      return;
    }
    const row = rowFor(key);
    if (row) fillLastCheckCell(row.children[4], sitesByKey.get(key));
    const reason = error.name === 'TimeoutError' ? 'The test took too long to answer.' : error.message;
    announce(`Could not test ${site.label}. ${reason}`, { error: true });
    return;
  } finally {
    const current = rowFor(key)?.querySelector('button[data-action="test"]');
    if (current) setBusy(current, null);
  }

  // The test ran. Reload the row for exact times, but never let a failed reload hide the result.
  let fresh = null;
  try {
    fresh = (await api('/admin/sites')).sites.find((candidate) => candidate.site_key === key) || null;
  } catch {
    fresh = null;
  }
  if (!fresh) {
    const now = new Date().toISOString();
    fresh = {
      ...site,
      last_error: result.ok ? null : result.error,
      last_verified_at: result.ok ? now : site.last_verified_at,
      updated_at: now,
    };
  }
  sitesByKey.set(key, fresh);
  const row = rowFor(key);
  if (row) {
    // Update cells in place so keyboard focus stays on the Test button.
    fillStatusCell(row.children[2], fresh);
    row.children[3].textContent = versionText(fresh);
    fillLastCheckCell(row.children[4], fresh);
  }
  announce(result.ok
    ? `${site.label} test passed. Verified at ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}.`
    : `${site.label} test failed: ${result.error}`);
}

function pairAgain(key) {
  const site = sitesByKey.get(key);
  if (!site) return;
  pairingResult.hidden = true;
  siteUrlInput.value = site.mcp_url;
  siteKeyInput.value = site.site_key;
  labelInput.value = site.label;
  environment.value = site.environment;
  environment.dispatchEvent(new Event('change'));
  if (site.environment === 'staging') writes.checked = Boolean(site.writes);
  siteUrlInput.focus();
  announce(`Add-site form filled in for ${site.label}. Check the details, then choose Create pairing code.`);
}

let removeGeneration = 0;
let removeErrorTimer;
let removalInFlight = null;
const removeCancel = $('#remove-cancel');

function showInDialog(message) {
  clearTimeout(removeErrorTimer);
  removeError.textContent = '';
  removeErrorTimer = setTimeout(() => { removeError.textContent = message; }, 50);
}

function openRemoveDialog(key, trigger) {
  const site = sitesByKey.get(key);
  if (!site) return;
  if (removalInFlight) {
    // One removal at a time, so its result is never announced behind another modal.
    announce(`Still removing ${removalInFlight.label}. Try again in a moment.`);
    return;
  }
  removeTarget = { key, label: site.label, trigger, generation: ++removeGeneration };
  $('#remove-dialog-site').textContent = site.label;
  clearTimeout(removeErrorTimer);
  removeError.textContent = '';
  // returnValue survives between openings; Escape would otherwise inherit "removed" and skip
  // returning focus to the button that opened the dialog.
  removeDialog.returnValue = '';
  removeDialog.showModal();
}

sitesBody.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const key = button.closest('tr')?.dataset.siteKey;
  if (!key) return;
  if (button.dataset.action === 'test') testSite(key, button);
  else if (button.dataset.action === 'repair') pairAgain(key);
  else if (button.dataset.action === 'remove') openRemoveDialog(key, button);
});

removeCancel.addEventListener('click', () => {
  if (isBusy(removeCancel)) {
    showInDialog('Still removing. This closes when the gateway answers.');
    return;
  }
  removeDialog.close('cancel');
});

// A removal cannot be called back once sent, so the dialog stays open until it finishes.
removeDialog.addEventListener('cancel', (event) => {
  if (removalInFlight) {
    event.preventDefault();
    showInDialog('Still removing. This closes when the gateway answers.');
  }
});

removeDialog.addEventListener('close', () => {
  if (removeDialog.returnValue === 'removed' || !removeTarget) return;
  // The row may have been re-rendered meanwhile; find its Remove button again by key.
  if (removeTarget.trigger?.isConnected) removeTarget.trigger.focus();
  else focusRowAction(removeTarget.key, 'remove');
});

removeConfirm.addEventListener('click', async () => {
  if (!removeTarget || isBusy(removeConfirm)) return;
  const target = removeTarget;
  const stillShowing = () => removeDialog.open && removeTarget?.generation === target.generation;
  setBusy(removeConfirm, 'Removing…');
  removeCancel.setAttribute('aria-disabled', 'true');
  removalInFlight = target;
  // Clear first so a repeated identical error is announced again.
  clearTimeout(removeErrorTimer);
  removeError.textContent = '';
  try {
    await api(`/admin/sites/${encodeURIComponent(target.key)}`, { method: 'DELETE' });
    if (stillShowing()) removeDialog.close('removed');
    const sites = await loadSites({ quiet: true, announceErrors: false });
    if (sites) {
      focusRowAction(target.key, 'repair');
      announce(`${target.label} removed. It stays in the list as Removed. Choose Pair again to reconnect it.`);
    } else {
      sitesHeading.focus();
      announce(`${target.label} was removed, but the list could not be refreshed. Choose Refresh sites to update it.`, { error: true });
    }
  } catch (error) {
    if (stillShowing()) {
      // The page behind a modal dialog is inert, so the error is announced inside the dialog.
      removeErrorTimer = setTimeout(() => { removeError.textContent = `Error: ${error.message}`; }, 50);
    } else {
      announce(`Could not remove ${target.label}. ${error.message}`, { error: true });
    }
  } finally {
    removalInFlight = null;
    removeCancel.removeAttribute('aria-disabled');
    setBusy(removeConfirm, null);
  }
});

if (adminToken) loadSites();
