import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMigratedDatabase } from '../shared/sqlite.js';

const migrations = fileURLToPath(new URL('../migrations/agent/', import.meta.url));

export function openAgentDatabase(filename) {
  return openMigratedDatabase(path.resolve(filename), migrations);
}
