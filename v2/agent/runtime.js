import { watch } from 'node:fs';
import { lstat, mkdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AgentCollector } from './collector.js';
import { AgentSyncClient } from './sync.js';
import { AGENT_VERSION, initializeManagedHome } from './config.js';

function delay(ms) { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }); }
function setState(database, key, value) {
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, value, at);
}
export async function canonicalHome(value, seen=new Set()) {
  const resolved=path.resolve(value),parsed=path.parse(resolved);
  const segments=resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current=parsed.root;
  for(let index=0;index<segments.length;index++){
    const candidate=path.join(current,segments[index]);
    try{
      const stat=await lstat(candidate);
      if(stat.isSymbolicLink()){
        const target=await readlink(candidate);
        const targetPath=path.resolve(path.dirname(candidate),target);
        if(seen.has(targetPath))throw new Error('CODEX_HOME contains a symbolic-link cycle');
        current=await canonicalHome(targetPath,new Set([...seen,targetPath]));
      }else current=candidate;
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
      current=path.join(current,...segments.slice(index));
      break;
    }
  }
  try{current=await realpath(current);}catch(error){if(error?.code!=='ENOENT')throw error;}
  return process.platform==='win32'?current.toLowerCase():current;
}
export async function assertProfilesCanonicalDisjoint(profiles) {
  const roots=[];
  const comparable=(value)=>process.platform==='win32'?value.toLowerCase():value;
  for(const profile of profiles)roots.push({accountId:profile.accountId,root:comparable(await canonicalHome(profile.codexHome))});
  for(let index=0;index<roots.length;index++)for(let other=index+1;other<roots.length;other++){
    const left=roots[index],right=roots[other];
    if(left.root===right.root||left.root.startsWith(`${right.root}${path.sep}`)||right.root.startsWith(`${left.root}${path.sep}`))
      throw new Error(`Profile CODEX_HOME roots must be dedicated and non-overlapping: ${left.accountId}, ${right.accountId}`);
  }
}
export async function bindProfileHome(database, profile) {
  const key = `profile_home:${profile.accountId}`;
  const canonical = await canonicalHome(profile.codexHome);
  const existing = database.prepare('SELECT value FROM agent_state WHERE key=?').get(key)?.value;
  const comparable=(value)=>process.platform==='win32'?value.toLowerCase():value;
  if (existing && comparable(await canonicalHome(existing)) !== comparable(canonical)) throw new Error('Account Profile CODEX_HOME cannot be rebound; archive it and create a new profile');
  if (!existing) setState(database, key, canonical);
}
export class AgentRuntime {
  constructor(database, config, options = {}) {
    this.database = database; this.config = config;
    this.collectors = options.collectors ?? (options.collector ? [options.collector] :
      (config.profiles?.length ? config.profiles.map((profile) => new AgentCollector(database, { home: profile.codexHome, accountId: profile.accountId })) : [new AgentCollector(database, { home: config.codexHome })]));
    this.syncClient = options.syncClient ?? new AgentSyncClient(database, config, options);
    this.running = false; this.watchers = []; this.reconciling = null; this.syncing = null; this.backoffMs = 1000; this.nextSyncAt = 0;
  }
  async reconcile() {
    if (!this.reconciling) this.reconciling = Promise.all(this.collectors.map((collector) => collector.reconcile()))
      .then((result) => { setState(this.database, 'last_collect_status', 'healthy'); return result; })
      .catch((error) => { setState(this.database, 'last_collect_status', 'degraded'); throw error; })
      .finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  async sync(heartbeat = false) {
    if (Date.now() < this.nextSyncAt) return { skipped: true, backoff: true, retryAt: new Date(this.nextSyncAt).toISOString() };
    const health = { status: this.database.prepare("SELECT value FROM agent_state WHERE key='last_collect_status'").get()?.value === 'degraded' ? 'degraded' : 'healthy' };
    if (!this.syncing) this.syncing = this.syncClient.sync({ heartbeat, health }).then((result) => { this.backoffMs = 1000; this.nextSyncAt = 0; return result; })
      .catch((error) => { this.nextSyncAt = Date.now() + this.backoffMs; this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000); throw error; })
      .finally(() => { this.syncing = null; });
    return this.syncing;
  }
  trigger() { this.reconcile().then(() => this.sync()).catch(() => {}); }
  async start() {
    if (this.running) return; this.running = true;
    const profiles = this.config.profiles ?? [];
    if (profiles.length) { await assertProfilesCanonicalDisjoint(profiles); for (const profile of profiles) await bindProfileHome(this.database, profile); await Promise.all(profiles.map((profile) => initializeManagedHome(profile.codexHome, profile.accountId))); }
    else await mkdir(this.config.codexHome, { recursive: true });
    await this.reconcile();
    const homes = profiles.length ? profiles.map((profile) => profile.codexHome) : [this.config.codexHome];
    for (const directory of homes.flatMap((home) => [home, path.join(home, 'sessions'), path.join(home, 'archived_sessions')])) {
      try { this.watchers.push(watch(directory, { persistent: directory === homes[0] }, () => this.trigger())); } catch { /* reconciliation is authoritative */ }
    }
    this.loops = [this.loop(this.config.reconcileIntervalMs, () => this.reconcile()),
      this.loop(this.config.syncIntervalMs, () => this.sync()), this.loop(this.config.heartbeatIntervalMs, () => this.sync(true))];
  }
  async loop(interval, action) {
    while (this.running) {
      await delay(interval); if (!this.running) break;
      try { await action(); } catch { /* sync applies exponential retry gating; reconciliation retries periodically */ }
    }
  }
  async stop() {
    this.running = false; for (const watcher of this.watchers) watcher.close(); this.watchers = [];
    await Promise.allSettled([this.reconciling, this.syncing].filter(Boolean));
  }
}

export function agentStatus(database, config) {
  const states = Object.fromEntries(database.prepare('SELECT key,value,updated_at FROM agent_state').all().map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
  const cursorStats = database.prepare(`SELECT COUNT(*) files,coalesce(SUM(malformed_lines),0) malformedLines,
    coalesce(SUM(oversized_lines),0) oversizedLines,coalesce(SUM(partial_lines),0) partialFiles FROM rollout_cursors`).get();
  return { agentVersion: AGENT_VERSION, deviceId: config.deviceId, serverUrl: config.serverUrl, running: states.runtime_status?.value === 'running',
    quotaReporter: states.is_quota_reporter?.value === 'true', quotaStatus: states.last_quota_status?.value ?? null,
    quotaErrorKind: states.last_quota_error_kind?.value || null, lastQuotaAttemptAt: states.last_quota_attempt_at?.value ?? null,
    profiles: (config.profiles ?? []).map((profile)=>{const quota=database.prepare('SELECT status,error_kind,attempted_at FROM profile_quota_status WHERE account_id=?').get(profile.accountId);return{accountId:profile.accountId,name:profile.name,quotaStatus:quota?.status??null,quotaErrorKind:quota?.error_kind??null,lastQuotaAttemptAt:quota?.attempted_at??null};}),
    outboxPending: database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count, cursors: cursorStats, states };
}