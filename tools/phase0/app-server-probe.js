#!/usr/bin/env node
import { AppServerClient, classifyError, normalizeAccount, normalizeAccountUsage, normalizeRateLimits } from './shared/app-server-client.js';
import { getCodexVersion, metadata } from './shared/core.js';
import { assertNoUnknown, option, printJson, writeJson } from './shared/output.js';

export async function runAppServerProbe({ now = new Date().toISOString(), command, timeoutMs } = {}) {
  const result = { ...metadata('app-server', now, await getCodexVersion(command)), capabilities: { accountRead: false, rateLimits: false, accountUsage: false, threadUsage: false }, account: null, rateLimits: { limits: [] }, accountUsage: null, errors: [] };
  const client = new AppServerClient({ command, timeoutMs });
  try {
    await client.start();
    for (const item of [
      ['accountRead', 'account/read', { refreshToken: false }, normalizeAccount, 'account'],
      ['rateLimits', 'account/rateLimits/read', null, normalizeRateLimits, 'rateLimits'],
      ['accountUsage', 'account/usage/read', null, normalizeAccountUsage, 'accountUsage']
    ]) {
      try {
        const raw = await client.request(item[1], item[2]); const normalized = item[3](raw);
        if (normalized == null) { result.errors.push({ method: item[1], code: null, kind: 'malformed_response', message: 'malformed_response' }); continue; }
        result.capabilities[item[0]] = true; result[item[4]] = normalized;
        if (item[0] === 'accountUsage') result.capabilities.threadUsage = normalized.threadUsage.available;
      }
      catch (error) { result.errors.push({ method: item[1], ...classifyError(error) }); }
    }
  } catch (error) { result.errors.push({ method: 'initialize', ...classifyError(error) }); }
  finally { await client.close(); }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2); assertNoUnknown(args, ['--output', '--timeout-ms']);
    const timeout = Number(option(args, '--timeout-ms', '10000')); if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60000) throw new Error('--timeout-ms must be 100..60000');
    const result = await runAppServerProbe({ timeoutMs: timeout }); const output = option(args, '--output');
    if (output) await writeJson(output, result); printJson(result);
  } catch (error) { console.error(`phase0 app-server probe: ${error.message}`); process.exitCode = 2; }
}
