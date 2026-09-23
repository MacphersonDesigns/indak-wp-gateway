#!/usr/bin/env node
'use strict';

/**
 * Apply pending database migrations by hand. The gateway also runs this on startup unless
 * DB_AUTO_MIGRATE=false, so a normal Hostinger redeploy needs no extra step.
 */

const { runMigrations } = require('../src/site-manager/Migrations');

runMigrations(process.env, {
  log: (row) => process.stdout.write(JSON.stringify(row) + '\n'),
}).catch((error) => {
  // Connection errors are actionable, but never print the configuration object because it
  // contains DB_PASSWORD.
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
