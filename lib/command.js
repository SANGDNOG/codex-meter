import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Build a shell-free spawn. Every original argument remains a distinct argv item. */
export function commandSpec(args, { platform = process.platform, command = process.env.CODEX_METER_CODEX || 'codex' } = {}) {
  if (!Array.isArray(args) || args.some((x) => typeof x !== 'string' || /[\0\r\n]/.test(x))) throw new Error('invalid command argument');
  if (/[\0\r\n]/.test(command)) throw new Error('invalid codex command');
  return { command, args: [...args], options: { stdio: 'inherit', shell: false, windowsVerbatimArguments: false } };
}

export function resolveCommand(args, env = process.env, platform = process.platform) {
  const explicit = env.CODEX_METER_CODEX;
  if (platform !== 'win32') return commandSpec(args, { platform, command: explicit || 'codex' });
  if (explicit && !/\.cmd$/i.test(explicit)) return commandSpec(args, { platform, command: explicit });
  const candidates = explicit ? [explicit] : spawnSync('where.exe', ['codex'], { encoding: 'utf8', shell: false }).stdout?.split(/\r?\n/).filter(Boolean) || [];
  const native = candidates.find((x) => /\.(exe|com)$/i.test(x));
  if (native) return commandSpec(args, { platform, command: native });
  // npm's codex.cmd has a deterministic adjacent package location. Execute its JS entry with Node,
  // rather than cmd.exe, eliminating command-line metacharacter expansion entirely.
  for (const shim of candidates.filter((x) => /\.cmd$/i.test(x))) {
    const entry = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entry)) return commandSpec([entry, ...args], { platform, command: process.execPath });
  }
  throw new Error('Could not find a safe native codex executable. Set CODEX_METER_CODEX to codex.exe (not .cmd).');
}
export function spawnCodex(args) { const spec = resolveCommand(args); return spawn(spec.command, spec.args, spec.options); }
