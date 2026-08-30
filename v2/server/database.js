import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMigratedDatabase } from '../shared/sqlite.js';

const migrations = fileURLToPath(new URL('../migrations/server/', import.meta.url));

export function openServerDatabase(filename) {
  return openMigratedDatabase(path.resolve(filename), migrations);
}
