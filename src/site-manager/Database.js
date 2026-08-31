'use strict';

const mysql = require('mysql2/promise');

const REQUIRED_DATABASE_ENV = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

function databaseConfigured(env = process.env) {
  return REQUIRED_DATABASE_ENV.every((name) => Boolean(env[name]));
}

function databaseConfig(env = process.env) {
  const missing = REQUIRED_DATABASE_ENV.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`Missing database environment variable(s): ${missing.join(', ')}`);
  }
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT) || 3306,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    charset: 'utf8mb4',
    waitForConnections: true,
    // Hostinger plans cap connections per user. Five is ample for this low-traffic gateway
    // and prevents a burst of WordPress calls from exhausting the account-wide allowance.
    connectionLimit: Math.min(Math.max(Number(env.DB_CONNECTION_LIMIT) || 5, 1), 10),
    queueLimit: 100,
    connectTimeout: Math.min(Math.max(Number(env.DB_CONNECT_TIMEOUT_MS) || 10000, 1000), 30000),
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  };
}

function createDatabasePool(env = process.env) {
  return mysql.createPool(databaseConfig(env));
}

module.exports = { REQUIRED_DATABASE_ENV, databaseConfigured, databaseConfig, createDatabasePool };
