#!/usr/bin/env node
'use strict';

/**
 * Small, forward-only migration runner.
 *
 * Why a dedicated runner: Hostinger redeploys application code, not database state. Each
 * immutable SQL file runs once and is recorded in schema_migrations, so a deployment can
 * safely repeat this command without rebuilding or deleting existing registry data.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function databaseConfig() {
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing database environment variable(s): ${missing.join(', ')}`);
  }
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: 'utf8mb4',
    // Multiple statements are confined to developer-owned migration files. Application
    // queries must remain parameterized and do not receive this capability.
    multipleStatements: true,
  };
}

async function run() {
  const connection = await mysql.createConnection(databaseConfig());
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB
    `);

    const directory = path.resolve(__dirname, '..', 'migrations');
    const files = fs.readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();

    for (const file of files) {
      const [rows] = await connection.execute(
        'SELECT version FROM schema_migrations WHERE version = ? LIMIT 1',
        [file]
      );
      if (rows.length) {
        process.stdout.write(JSON.stringify({ event: 'migration_skip', version: file }) + '\n');
        continue;
      }

      const sql = fs.readFileSync(path.join(directory, file), 'utf8');
      // DDL auto-commits in MySQL, so migrations must be additive and individually safe to
      // retry. Recording happens only after the full file completes successfully.
      await connection.query(sql);
      await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      process.stdout.write(JSON.stringify({ event: 'migration_apply', version: file }) + '\n');
    }
  } finally {
    await connection.end();
  }
}

run().catch((error) => {
  // Connection errors are actionable, but never print the configuration object because it
  // contains DB_PASSWORD.
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
