#!/usr/bin/env node
'use strict';
/**
 * Prints the two things you need to add a site: the registry entry and the
 * env var name for its application password. Copy/paste, nothing clever.
 *
 *   node scripts/newsite.js lundoil "Lund Oil (staging)" https://staging.lundoil.com staging
 */
const [key, label, base, env] = process.argv.slice(2);

if (!key || !base) {
  console.log(`
Usage:
  node scripts/newsite.js <key> "<label>" <https://url> [live|staging]

Example:
  node scripts/newsite.js lundoil "Lund Oil (staging)" https://staging.lundoil.com staging

The key is the lowercase of the client's ClickUp Space abbreviation, so the word
people say out loud matches where the work is tracked.
`);
  process.exit(1);
}

const k = key.trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9-]*$/.test(k)) {
  console.error(`Bad key "${key}". Lowercase letters, digits and dashes only.`);
  process.exit(1);
}

let origin;
try {
  origin = new URL(base).origin;
} catch {
  console.error(`Bad URL "${base}". Include https://`);
  process.exit(1);
}
if (!origin.startsWith('https://')) {
  console.error('The site must be HTTPS. ClickUp and the gateway both require it.');
  process.exit(1);
}

const e = (env || (/staging|dev|test/.test(origin) ? 'staging' : 'live')).toLowerCase();
if (e !== 'live' && e !== 'staging') {
  console.error(`env must be "live" or "staging", got "${env}".`);
  process.exit(1);
}
const secret = `WP_PW_${k.toUpperCase().replace(/-/g, '_')}`;
const lbl = (label || key).trim();

if (e === 'staging' && !/staging/i.test(lbl)) {
  console.error(`\nHeads up: label "${lbl}" does not say staging. Put it in the label so it shows in Brain's output.\n`);
}

const entry = {
  [k]: {
    label: lbl,
    base: origin,
    env: e,
    user: 'novamira-bot',
    appPasswordEnv: secret,
    // Staging is disposable, so the team can actually work. Live stays read-only,
    // and root-class abilities are refused on live regardless of this flag.
    writes: e === 'staging',
  },
};

console.log(`
1. Add this line to the SITES environment variable on the host
   (one site per line, and it needs no quotes or braces):

   ${k} | ${lbl} | ${origin} | ${e}${e === 'live' ? ' | false' : ''}

2. Add this password variable, set to ${lbl}'s WordPress
   application password for the novamira-bot user:

   ${secret}

3. On ${origin}: Novamira active with AI Abilities enabled, a novamira-bot admin user,
   and an application password generated for it.

4. Redeploy or restart, then confirm the domain root lists "${k}", and that ${k} AND an
   existing site both answer in the same Brain conversation.

${e === 'staging'
  ? 'Writes are on because this is staging: the team can build here without asking you first.'
  : 'Writes are OFF because this is LIVE. Reads work for everyone. Root-class abilities\n(PHP, file writes, WP-CLI) are refused on live no matter what.'}

Equivalent JSON, if you would rather use REGISTRY_JSON:

${JSON.stringify(entry, null, 2).replace(/^\{\n|\n\}$/g, '').replace(/^ {2}/gm, '')}
`);
