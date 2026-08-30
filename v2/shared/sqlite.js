import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATION_NAME = /^(\d{3})_([a-z][a-z0-9_]*)\.sql$/;
let embeddedMigrations = null;

export function setEmbeddedMigrations(value) { embeddedMigrations = Object.freeze(value); }

function migrations(directory) {
  const embedded = embeddedMigrations?.[path.basename(path.resolve(directory))];
  if (embedded) return embedded.map(({ filename, sql }, index) => migration(filename, sql, index));
  const files = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
  return files.map((filename, index) => migration(filename, readFileSync(path.join(directory, filename), 'utf8'), index));
}
function migration(filename, sql, index) {
    const match = filename.match(MIGRATION_NAME);
    if (!match) throw new Error(`invalid migration filename: ${filename}`);
    const version = Number(match[1]);
    if (version !== index + 1) throw new Error(`migration sequence must be contiguous at ${filename}`);
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { version, name: match[2], sql, checksum };
}

export function migrateDatabase(database, directory) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  for (const migration of migrations(directory)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      // Recheck under the write lock so concurrent startups cannot both apply
      // a migration based on the same stale pre-lock snapshot.
      const applied = database.prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?').get(migration.version);
      if (applied) {
        if (applied.name !== migration.name) throw new Error(`migration ${migration.version} name mismatch`);
        if (applied.checksum !== migration.checksum) throw new Error(`migration ${migration.version} checksum mismatch`);
        database.exec('COMMIT');
        continue;
      }
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openMigratedDatabase(filename, migrationDirectory) {
  const database = new DatabaseSync(filename);
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    // SQLite creates the database and WAL sidecars using the process umask.
    // They contain credential hashes and usage metadata, so force user-only
    // access even when the surrounding data directory is more permissive.
    for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
    migrateDatabase(database, migrationDirectory);
    for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
