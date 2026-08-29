#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { analyzeAccounting } from './shared/accounting.js';
import { assertNoUnknown, option, printJson, writeJson } from './shared/output.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2); assertNoUnknown(args, ['--input', '--output']);
    const input = option(args, '--input', 'phase0-output/rollout-inspection.json'); const inspection = JSON.parse(await readFile(input, 'utf8'));
    const result = analyzeAccounting(inspection); const output = option(args, '--output', 'phase0-output/accounting.json'); await writeJson(output, result); printJson(result);
  } catch (error) { console.error(`phase0 accounting analyzer: ${error.message}`); process.exitCode = 2; }
}
