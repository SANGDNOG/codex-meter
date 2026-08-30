#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { openServerDatabase } from '../v2/server/database.js';
import { createV2Server } from '../v2/server/http.js';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 15)) {
  console.error('Codex Meter V2 Server requires Node.js 24.15 or newer.');
  process.exit(1);
}
const databaseFile = path.resolve(process.env.CODEX_METER_DB ?? './data/meter.db');
const adminPassword = process.env.CODEX_METER_ADMIN_PASSWORD;
const host = process.env.CODEX_METER_HOST ?? '127.0.0.1';
const port = Number(process.env.CODEX_METER_PORT ?? '3000');
const quotaStaleSeconds = Number(process.env.CODEX_METER_QUOTA_STALE_SECONDS ?? '300');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('CODEX_METER_PORT must be an integer from 0 to 65535.'); process.exit(1);
}
if (!Number.isSafeInteger(quotaStaleSeconds) || quotaStaleSeconds < 1 || quotaStaleSeconds > 86400) {
  console.error('CODEX_METER_QUOTA_STALE_SECONDS must be an integer from 1 to 86400.'); process.exit(1);
}
mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
const database = openServerDatabase(databaseFile);
const configuredUrl = process.env.CODEX_METER_SERVER_URL ?? `http://${host}:${port}`;
const trustedProxyAddresses = (process.env.CODEX_METER_TRUSTED_PROXIES ?? '127.0.0.1,::1').split(',').map((value) => value.trim()).filter(Boolean);
if (trustedProxyAddresses.some((value) => !isIP(value))) {
  database.close(); console.error('CODEX_METER_TRUSTED_PROXIES must be a comma-separated list of exact IP addresses.'); process.exit(1);
}
let server;
try {
  server = createV2Server({ database, adminPassword, serverUrl: configuredUrl, quotaStaleMs: quotaStaleSeconds * 1000, trustedProxyAddresses,
    releaseDirectory: process.env.CODEX_METER_RELEASE_DIR ? path.resolve(process.env.CODEX_METER_RELEASE_DIR) : null });
} catch (error) {
  database.close();
  console.error(error.message === 'adminPassword is required for first startup'
    ? 'CODEX_METER_ADMIN_PASSWORD is required for first startup.' : error.message);
  process.exit(1);
}
server.listen(port, host, () => {
  const address = server.address();
  console.log(`Codex Meter V2 Server listening on http://${host}:${address.port}`);
});
function shutdown() {
  server.close(() => { database.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
