import { chmod } from 'node:fs/promises';
import { AGENT_VERSION, defaultConfigPath, enroll, loadConfig } from './config.js';
import { openAgentDatabase } from './database.js';
import { AgentRuntime, agentStatus } from './runtime.js';
import { lifecyclePaths, serviceStatus, uninstallInstalledAgent, updateInstalledAgent } from './lifecycle.js';

function option(args, name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; }
function usage() { return 'usage: codex-meter-agent <run|enroll|status|update|uninstall|version>'; }
export async function runAgentCli(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const command = args[0]; const configPath = option(args, '--config') || defaultConfigPath();
  if (command === 'version' || command === '--version') { stdout.write(`${AGENT_VERSION}\n`); return 0; }
  if (command === 'enroll') {
    const serverUrl = option(args, '--server'); const token = option(args, '--token');
    if (!serverUrl || !token) throw new Error('enroll requires --server and --token');
    await enroll({ serverUrl, token, configPath, allowHttpForTests: args.includes('--allow-http-for-tests'), codexHome: option(args, '--codex-home') || undefined });
    stdout.write('enrolled\n'); return 0;
  }
  const config = await loadConfig(configPath);
  if (command === 'status') {
    const database = openAgentDatabase(config.databasePath); try { stdout.write(`${JSON.stringify({ ...agentStatus(database, config), ...await serviceStatus(lifecyclePaths()) }, null, 2)}\n`); } finally { database.close(); } return 0;
  }
  if (command === 'update') {
    stdout.write(`${JSON.stringify(await updateInstalledAgent(config))}\n`); return 0;
  }
  if (command === 'uninstall') {
    if (!args.includes('--yes')) throw new Error('uninstall requires --yes');
    await uninstallInstalledAgent(configPath, config);
    stdout.write('uninstalled\n'); return 0;
  }
  if (command === 'run') {
    if (process.platform !== 'win32') await chmod(configPath, 0o600);
    const database = openAgentDatabase(config.databasePath); const runtime = new AgentRuntime(database, config);
    try {
      const at = new Date().toISOString(); database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES('runtime_status','running',?)
        ON CONFLICT(key) DO UPDATE SET value='running',updated_at=excluded.updated_at`).run(at);
      await runtime.start();
      await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
      return 0;
    } finally {
      await runtime.stop();
      database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES('runtime_status','stopped',?)
        ON CONFLICT(key) DO UPDATE SET value='stopped',updated_at=excluded.updated_at`).run(new Date().toISOString());
      database.close();
    }
  }
  stderr.write(`${usage()}\n`); return 2;
}