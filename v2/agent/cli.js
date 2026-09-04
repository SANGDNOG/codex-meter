import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_VERSION, defaultConfigPath, enroll, initializeManagedHome, loadConfig, profileLauncher, saveConfig, validateConfig } from './config.js';
import { openAgentDatabase } from './database.js';
import { AgentRuntime, agentStatus, assertProfilesCanonicalDisjoint, bindProfileHome, canonicalHome } from './runtime.js';
import { applyDesiredConfiguration, importLegacyProfiles } from './assignments.js';
import { AgentCollector } from './collector.js';
import { lifecyclePaths, serviceStatus, uninstallInstalledAgent, updateInstalledAgent } from './lifecycle.js';

function option(args, name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; }
function usage() { return 'usage: codex-meter-agent <run|enroll|status|profile-add|profile-launcher|update|uninstall|version>'; }
export async function runAgentCli(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const command = args[0]; const configPath = option(args, '--config') || defaultConfigPath();
  if (command === 'version' || command === '--version') { stdout.write(`${AGENT_VERSION}\n`); return 0; }
  if (command === 'enroll') {
    const serverUrl = option(args, '--server'); const token = option(args, '--token');
    if (!serverUrl || !token) throw new Error('enroll requires --server and --token');
    const enrollment=await enroll({ serverUrl, token, configPath, allowHttpForTests: args.includes('--allow-http-for-tests'), codexHome: option(args, '--codex-home') || undefined,
      codexExecutable: option(args, '--codex-executable') || undefined });
    if(enrollment.desiredConfiguration){const database=openAgentDatabase(enrollment.config.databasePath);try{await importLegacyProfiles(database,enrollment.config);const applied=await applyDesiredConfiguration(database,enrollment.config,enrollment.desiredConfiguration);if(!applied.applied&&!applied.idempotent)throw applied.error??new Error('initial desired configuration failed');}finally{database.close();}}
    stdout.write('enrolled\n'); return 0;
  }
  const config = await loadConfig(configPath);
  if (command === 'profile-add') {
    const accountId=option(args,'--account');const name=option(args,'--name');const codexHome=option(args,'--codex-home');const codexExecutable=option(args,'--codex-executable');
    if(!accountId||!name||!codexHome)throw new Error('profile-add requires --account, --name, and --codex-home');
    const candidate=validateConfig({...config,profiles:[...config.profiles,{accountId,name,codexHome,...(codexExecutable?{codexExecutable}:{})}]});
    await assertProfilesCanonicalDisjoint(candidate.profiles);
    let database=openAgentDatabase(config.databasePath);
    try {
      const running=database.prepare("SELECT value FROM agent_state WHERE key='runtime_status'").get()?.value==='running';
      const legacyRoot=await canonicalHome(config.codexHome),profileRoot=await canonicalHome(codexHome);
      const comparable=(value)=>process.platform==='win32'?value.toLowerCase():value;
      const legacyComparable=comparable(legacyRoot),profileComparable=comparable(profileRoot);
      if(running&&(legacyComparable===profileComparable||legacyComparable.startsWith(`${profileComparable}${path.sep}`)||profileComparable.startsWith(`${legacyComparable}${path.sep}`)))
        throw new Error('stop the running Agent before adopting its legacy CODEX_HOME as a profile');
    }
    finally { database.close(); }
    await initializeManagedHome(candidate.profiles.find((profile)=>profile.accountId===accountId).codexHome,accountId);
    // Establish the installation baseline before exposing the launcher/config.
    database=openAgentDatabase(config.databasePath);
    try { await bindProfileHome(database,{accountId,codexHome}); await new AgentCollector(database,{home:codexHome,accountId}).reconcile(); }
    finally { database.close(); }
    await saveConfig(configPath,candidate);
    stdout.write(`profile added: ${accountId}\n`);return 0;
  }
  if (command === 'profile-launcher') {
    const accountId=option(args,'--account');const profile=config.profiles.find((item)=>item.accountId===accountId);
    if(!profile)throw new Error('profile-launcher requires a configured --account');
    stdout.write(profileLauncher({...profile,codexExecutable:profile.codexExecutable??config.codexExecutable}));return 0;
  }
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
    let stopRequested = false; let resolveStop;
    const stopped = new Promise((resolve) => { resolveStop = resolve; });
    const requestStop = () => { stopRequested = true; resolveStop(); };
    process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);
    // An empty declarative configuration has no persistent filesystem watchers.
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      const at = new Date().toISOString(); database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES('runtime_status','running',?)
        ON CONFLICT(key) DO UPDATE SET value='running',updated_at=excluded.updated_at`).run(at);
      await runtime.start();
      if (!stopRequested) await stopped;
      return 0;
    } finally {
      clearInterval(keepAlive);
      try {
        await runtime.stop();
        database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES('runtime_status','stopped',?)
          ON CONFLICT(key) DO UPDATE SET value='stopped',updated_at=excluded.updated_at`).run(new Date().toISOString());
      } finally {
        process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop); database.close();
      }
    }
  }
  stderr.write(`${usage()}\n`); return 2;
}
