'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { databaseConfig } = require('./Database');

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, '..', '..', 'migrations');
const LOCK_NAME = 'indak_gateway_migrations';

/**
 * Forward-only migration runner shared by `npm run db:migrate` and gateway startup.
 *
 * Hostinger redeploys application code, not database state, so each immutable SQL file runs
 * once and is recorded in schema_migrations. An advisory lock keeps two booting processes from
 * applying the same file at the same time.
 */
async function runMigrations(env = process.env, { log = () => {} } = {}) {
  const config = databaseConfig(env);
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    charset: config.charset,
    connectTimeout: config.connectTimeout,
    // Multiple statements are confined to developer-owned migration files. Application
    // queries must remain parameterized and do not receive this capability.
    multipleStatements: true,
  });
  const applied = [];
  let locked = false;
  try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error('Timed out waiting for the migration lock.');
    locked = true;

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB
    `);

    const files = fs.readdirSync(MIGRATIONS_DIRECTORY).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const file of files) {
      const [rows] = await connection.execute(
        'SELECT version FROM schema_migrations WHERE version = ? LIMIT 1',
        [file]
      );
      if (rows.length) {
        log({ event: 'migration_skip', version: file });
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIRECTORY, file), 'utf8');
      // DDL auto-commits in MySQL, so migrations must be additive and individually safe to
      // retry. Recording happens only after the full file completes successfully.
      await connection.query(sql);
      await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      applied.push(file);
      log({ event: 'migration_apply', version: file });
    }
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    await connection.end().catch(() => {});
  }
  return applied;
}

module.exports = { runMigrations, MIGRATIONS_DIRECTORY };
