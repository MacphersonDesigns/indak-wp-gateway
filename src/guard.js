'use strict';

/**
 * Ability classification. DEFAULT-DENY: anything not recognised as a read
 * counts as a write. Novamira adds abilities often; new ones must be reviewed
 * by a human before they can run on a site with writes disabled.
 */

// Abilities that are effectively root on the box. Refused on env:"live"
// unless ALLOW_LIVE_ROOT=true is set deliberately.
const ROOT_ABILITIES = new Set([
  'novamira/execute-php',
  'novamira/write-file',
  'novamira/edit-file',
  'novamira/delete-file',
  'novamira/run-wp-cli',
  'novamira/create-upload-link',
  'novamira/create-admin-access-link',
]);

// Explicit read allowlist wins over everything below.
const READ_ABILITIES = new Set([
  'novamira/read-file',
  'novamira/list-directory',
  'novamira/agent-context',
  'novamira/skill-get',
  'novamira/get-active-design',
  'novamira/get-design',
  'novamira/list-design-library',
  'novamira/check-design',
  'novamira/get-wp-cli-job',
  'mcp-adapter/discover-abilities',
]);

// Verb fragments that mark a mutation. Checked against the last path segment.
const WRITE_VERBS = [
  'add', 'create', 'update', 'delete', 'write', 'edit', 'save', 'set',
  'activate', 'deactivate', 'enable', 'disable', 'execute', 'run',
  'install', 'uninstall', 'upload', 'import', 'flush', 'reset', 'sync',
];

// Verb fragments that mark a read.
const READ_VERBS = [
  'get', 'list', 'discover', 'info', 'read', 'search', 'query',
  'overview', 'audit', 'check', 'status', 'output', 'performance', 'decay',
];

function tail(abilityName) {
  const s = String(abilityName || '').toLowerCase();
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

function isRootAbility(abilityName) {
  return ROOT_ABILITIES.has(String(abilityName || '').toLowerCase());
}

/**
 * @returns {{ write: boolean, reason: string }}
 */
function classify(abilityName) {
  const full = String(abilityName || '').toLowerCase();
  if (!full) return { write: true, reason: 'empty ability name' };
  if (ROOT_ABILITIES.has(full)) return { write: true, reason: 'root-class ability' };
  if (READ_ABILITIES.has(full)) return { write: false, reason: 'read allowlist' };

  const t = tail(full);
  const parts = t.split('-').filter(Boolean);

  for (const v of WRITE_VERBS) {
    if (parts.includes(v)) return { write: true, reason: `write verb "${v}"` };
  }
  for (const v of READ_VERBS) {
    if (parts.includes(v)) return { write: false, reason: `read verb "${v}"` };
  }
  return { write: true, reason: 'unrecognised ability, treated as a write' };
}

const isWriteAbility = (n) => classify(n).write;

module.exports = { classify, isWriteAbility, isRootAbility, ROOT_ABILITIES, READ_ABILITIES };
