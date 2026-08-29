#!/usr/bin/env node
import { inspectRollouts } from './shared/rollout.js';
import { assertNoUnknown, has, option, printJson, writeJson } from './shared/output.js';
import { sessionsRoot } from './shared/paths.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2); assertNoUnknown(args, ['--sessions', '--codex-home', '--output', '--secret-file'], ['--raw-session-ids']);
    const result = await inspectRollouts({ root: sessionsRoot(option(args, '--sessions'), option(args, '--codex-home')), rawIds: has(args, '--raw-session-ids'), secretFile: option(args, '--secret-file') || undefined });
    const output = option(args, '--output', 'phase0-output/rollout-inspection.json'); await writeJson(output, result); printJson(result);
  } catch (error) { console.error(`phase0 rollout inspector: ${error.message}`); process.exitCode = 2; }
}
