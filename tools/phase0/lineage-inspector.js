#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { buildLineage, lineageText } from './shared/accounting.js';
import { assertNoUnknown, has, option, printJson, writeJson } from './shared/output.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2); assertNoUnknown(args, ['--input', '--output'], ['--text']);
    const input = option(args, '--input', 'phase0-output/rollout-inspection.json'); const inspection = JSON.parse(await readFile(input, 'utf8'));
    const result = buildLineage(inspection); const output = option(args, '--output', 'phase0-output/lineage.json'); await writeJson(output, result);
    if (has(args, '--text')) process.stdout.write(lineageText(result)); else printJson(result);
  } catch (error) { console.error(`phase0 lineage inspector: ${error.message}`); process.exitCode = 2; }
}
