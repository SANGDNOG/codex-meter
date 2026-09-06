import { watch, lstatSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AgentCollector } from './collector.js';
import { AgentSyncClient } from './sync.js';
import { AGENT_VERSION } from './config.js';
import { applyDesiredConfiguration, assignmentRows, importLegacyProfiles } from './assignments.js';
import { canonicalHome, homesOverlap } from './paths.js';
import { discoverExistingRollouts } from './existing-home.js';
import { rootIdentityMatches } from './existing-root.js';

export { canonicalHome } from './paths.js';

function delay(ms) { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }); }
function setState(database, key, value) {
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, value, at);
}
export async function assertProfilesCanonicalDisjoint(profiles) {
  const roots=[];
  const comparable=(value)=>process.platform==='win32'?value.toLowerCase():value;
  for(const profile of profiles)roots.push({accountId:profile.accountId,root:comparable(await canonicalHome(profile.codexHome))});
  for(let index=0;index<roots.length;index++)for(let other=index+1;other<roots.length;other++){
    const left=roots[index],right=roots[other];
    if(homesOverlap(left.root,right.root))
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
    this.fixedCollectors=options.fixedCollectors===true;
    this.collectorFactory=options.collectorFactory??((entry)=>new AgentCollector(database,{home:entry.localHome??entry.codexHome,accountId:entry.accountId??null,...(entry.mode==='existing'?{bindingKey:`${entry.accountId}:${entry.selectionKey}`,discovery:discoverExistingRollouts}:{})}));
    this.watchImpl=options.watchImpl??watch;this.applyOptions=options.applyOptions??{};
    this.collectors = options.collectors ?? (options.collector ? [options.collector] : []);
    this.syncClient = options.syncClient ?? new AgentSyncClient(database, config, options);
    this.running = false; this.watchers = []; this.reconciling = null; this.syncing = null; this.backoffMs = 1000; this.nextSyncAt = 0;this.operation=Promise.resolve();
    if(!options.collectors&&!options.collector){
      if(config.profiles?.length&&!assignmentRows(database).length){this.collectors=config.profiles.map(profile=>this.collectorFactory({...profile,localHome:profile.codexHome}));this.assignmentFingerprint=this.assignmentSignature();}
      else this.installAssignments();
    }else this.assignmentFingerprint=this.assignmentSignature();
  }
  serialized(action){const result=this.operation.then(action,action);this.operation=result.catch(()=>{});return result;}
  async reconcileUnlocked() {
    await this.refreshLocalAssignments();
    if (!this.reconciling) this.reconciling = Promise.allSettled(this.collectors.map((collector) => collector.reconcile()))
      .then((results)=>{const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;return results.map(result=>result.value);})
      .then((result) => { setState(this.database, 'last_collect_status', 'healthy'); return result; })
      .catch((error) => { setState(this.database, 'last_collect_status', 'degraded'); throw error; })
      .finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  reconcile(){return this.serialized(()=>this.reconcileUnlocked());}
  activeAssignments(){return assignmentRows(this.database).filter(entry=>entry.localHome!==null).map((entry)=>({...entry,codexHome:entry.localHome}));}
  assignmentSignature(){return JSON.stringify(assignmentRows(this.database).map(entry=>[entry.bindingId,entry.accountId,entry.mode,entry.localHome,entry.selectionKey]));}
  async refreshLocalAssignments(){
    if(this.fixedCollectors)return;
    const state=key=>this.database.prepare('SELECT value FROM agent_state WHERE key=?').get(key)?.value;
    if((state('local_selection_revision')??'0')!==(state('applied_local_selection_revision')??'0')){
      const cached=state('desired_configuration');if(cached)await this.applyConfigurationUnlocked(JSON.parse(cached));
    }
    if(this.assignmentFingerprint!==this.assignmentSignature()){this.installAssignments();if(this.running)this.refreshWatchers();}
  }
  installAssignments(){
    if(this.fixedCollectors)return;
    this.assignmentFingerprint=this.assignmentSignature();
    const assignments=this.activeAssignments();
    const appliedRevision=Number(this.database.prepare("SELECT value FROM agent_state WHERE key='applied_config_revision'").get()?.value??0);
    const legacyFallback=!Number.isSafeInteger(appliedRevision)||appliedRevision===0;
    this.collectors=assignments.length?assignments.map((entry)=>this.collectorFactory(entry)):
      (legacyFallback?[this.collectorFactory({localHome:this.config.codexHome,accountId:null})]:[]);
    this.syncClient.configureProfiles(assignments,{legacyFallback});
  }
  refreshWatchers(){
    for(const watcher of this.watchers)watcher.close();this.watchers=[];
    const homes=this.collectors.map((collector)=>collector.home),adopted=new Map(this.activeAssignments().filter(entry=>entry.mode==='existing').map(entry=>[entry.localHome,entry.rootIdentity]));
    for(const home of homes){
      if(adopted.has(home)){
        try{const canonical=realpathSync(home);if((process.platform==='win32'?canonical.toLowerCase():canonical)!==home||!rootIdentityMatches(adopted.get(home),home,lstatSync(home,{bigint:true})))continue;}
        catch{continue;}
      }
      for(const directory of [home,path.join(home,'sessions'),path.join(home,'archived_sessions')]){
        try{if(adopted.has(home)&&lstatSync(directory).isSymbolicLink())continue;this.watchers.push(this.watchImpl(directory,{persistent:directory===homes[0]},()=>this.trigger()));}catch{/* reconciliation is authoritative */}
      }
    }
  }
  async applyConfigurationUnlocked(configuration){
    if(!configuration||configuration.schemaVersion!==1)return null;
    const applied=await applyDesiredConfiguration(this.database,this.config,configuration,this.applyOptions);
    if(applied.applied){this.installAssignments();if(this.running)this.refreshWatchers();}
    return applied;
  }
  applyConfiguration(configuration){return this.serialized(()=>this.applyConfigurationUnlocked(configuration));}
  async sync(heartbeat = false, {collectQuota=true} = {}) {
    return this.serialized(async()=>{
      await this.refreshLocalAssignments();
      if (Date.now() < this.nextSyncAt) return { skipped: true, backoff: true, retryAt: new Date(this.nextSyncAt).toISOString() };
      const health = { status: this.database.prepare("SELECT value FROM agent_state WHERE key='last_collect_status'").get()?.value === 'degraded' ? 'degraded' : 'healthy' };
      if (!this.syncing) this.syncing = this.syncClient.sync({ heartbeat, health, collectQuota }).then(async(result) => {this.backoffMs=1000;this.nextSyncAt=0;result.configurationApply=await this.applyConfigurationUnlocked(result.configuration);return result;})
        .catch((error) => { this.nextSyncAt = Date.now() + this.backoffMs; this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);const diagnostic=this.database.prepare("SELECT value FROM agent_state WHERE key='last_sync_error_kind'").get()?.value;if(diagnostic)console.error(`Codex Meter sync failed: ${diagnostic}`);throw error; })
        .finally(() => { this.syncing = null; });
      return this.syncing;
    });
  }
  trigger() {
    if(!this.running)return Promise.resolve();
    if(this.triggerWork){this.triggerDirty=true;return this.triggerWork;}
    this.triggerDirty=false;
    this.triggerWork=this.reconcile().then(()=>{if(this.running)return this.sync();}).catch(()=>{}).finally(()=>{
      this.triggerWork=null;
      if(this.triggerDirty&&this.running)this.trigger();
    });
    return this.triggerWork;
  }
  async start() {
    if (this.running) return; this.running = true;
    const profiles = this.config.profiles ?? [];
    if (profiles.length) { await assertProfilesCanonicalDisjoint(profiles); for (const profile of profiles) await bindProfileHome(this.database, profile); }
    else {
      const appliedRevision=Number(this.database.prepare("SELECT value FROM agent_state WHERE key='applied_config_revision'").get()?.value??0);
      if(!Number.isSafeInteger(appliedRevision)||appliedRevision===0)await mkdir(this.config.codexHome,{recursive:true});
    }
    await importLegacyProfiles(this.database,this.config);this.installAssignments();
    // A missing adopted environment must not prevent heartbeat/recovery or the
    // other profiles' collection. Reconciliation records degraded health.
    try{await this.reconcile();}catch{/* Normal retry loops and remote configuration remain available. */}
    this.refreshWatchers();
    // Connect immediately without waiting for quota collection or the first minute timer.
    // A second handshake acknowledges newly received configuration/capabilities.
    const hadActualState=this.database.prepare("SELECT value FROM agent_state WHERE key='remote_actual_state_supported'").get()?.value==='true';
    try{const initial=await this.sync(true,{collectQuota:false});if(!initial.skipped&&(!hadActualState||initial.configurationApply?.applied))await this.sync(true,{collectQuota:false});}catch{/* Persisted diagnostics and the normal retry loops handle unavailable servers. */}
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
    await Promise.allSettled([this.operation,this.triggerWork,this.reconciling, this.syncing].filter(Boolean));
  }
}

export function agentStatus(database, config) {
  const states = Object.fromEntries(database.prepare('SELECT key,value,updated_at FROM agent_state').all().map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
  const cursorStats = database.prepare(`SELECT COUNT(*) files,coalesce(SUM(malformed_lines),0) malformedLines,
    coalesce(SUM(oversized_lines),0) oversizedLines,coalesce(SUM(partial_lines),0) partialFiles FROM rollout_cursors`).get();
  return { agentVersion: AGENT_VERSION, deviceId: config.deviceId, serverUrl: config.serverUrl, running: states.runtime_status?.value === 'running',
    connection:{status:states.last_sync_status?.value??'waiting',lastAttemptAt:states.last_sync_attempt_at?.value??null,lastSuccessAt:states.last_sync_at?.value??null,errorKind:states.last_sync_error_kind?.value||null},
    trackedProfiles:assignmentRows(database).map(profile=>({accountId:profile.accountId,name:profile.name,mode:profile.mode,codexHome:profile.localHome,state:profile.state})),
    quotaReporter: states.is_quota_reporter?.value === 'true', quotaStatus: states.last_quota_status?.value ?? null,
    quotaErrorKind: states.last_quota_error_kind?.value || null, lastQuotaAttemptAt: states.last_quota_attempt_at?.value ?? null,
    profiles: (config.profiles ?? []).map((profile)=>{const quota=database.prepare('SELECT status,error_kind,attempted_at FROM profile_quota_status WHERE account_id=?').get(profile.accountId);return{accountId:profile.accountId,name:profile.name,quotaStatus:quota?.status??null,quotaErrorKind:quota?.error_kind??null,lastQuotaAttemptAt:quota?.attempted_at??null};}),
    outboxPending: database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count, cursors: cursorStats, states };
}
