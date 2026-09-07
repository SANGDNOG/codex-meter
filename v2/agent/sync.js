import { AGENT_VERSION } from './config.js';
import { QuotaReporter } from './app-server.js';
import { configurationState } from './assignments.js';
import { assertExistingQuotaLocation } from './existing-quota-runner.js';
import { AGENT_CAPABILITY_HEADER, AGENT_CAPABILITY_HEADER_VALUE, EXISTING_HOME_HEADER, parseServerCapabilities } from '../shared/capabilities.js';

const COLUMNS = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const WIRE = ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];

function outboxRows(database, limit) {
  const statement = database.prepare('SELECT * FROM usage_outbox ORDER BY sequence LIMIT ?');
  statement.setReadBigInts(true);
  return statement.all(limit);
}
function wire(row) {
  const event = { eventId: row.event_id, occurredAt: row.occurred_at, model: row.model, reasoningEffort: row.reasoning_effort };
  if (row.account_id !== null) event.accountId = row.account_id;
  for (let i = 0; i < COLUMNS.length; i++) event[WIRE[i]] = row[COLUMNS[i]] == null ? null : row[COLUMNS[i]].toString();
  return event;
}
function state(database, key, value, clock) {
  const at = new Date(clock()).toISOString();
  database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), at);
}
function profileQuotaState(database, report, clock) {
  const attemptedAt = new Date(clock()).toISOString();
  database.prepare(`INSERT INTO profile_quota_status(account_id,status,error_kind,attempted_at) VALUES(?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET status=excluded.status,error_kind=excluded.error_kind,attempted_at=excluded.attempted_at`)
    .run(report.accountId, report.status, report.errorKind ?? null, attemptedAt);
  const stateValue=report.errorKind==='not_authenticated'?'login_required':report.status==='available'?'quota_available':'quota_unavailable';
  database.prepare('UPDATE profile_assignments SET state=?,updated_at=? WHERE account_id=? AND active=1').run(stateValue,attemptedAt,report.accountId);
}

export class AgentSyncClient {
  constructor(database, config, { fetchImpl = fetch, clock = Date.now, codexVersion = null, timeoutMs = 30_000, quotaReporter, quotaReporterFactory } = {}) {
    this.database = database; this.config = config; this.fetch = fetchImpl; this.clock = clock; this.codexVersion = codexVersion; this.timeoutMs = timeoutMs;
    this.quotaReporterFactory=quotaReporterFactory??((profile)=>new QuotaReporter({clock:this.clock,accountId:profile.accountId,codexHome:profile.localHome??profile.codexHome,readOnlyHome:profile.mode==='existing',isolationOptions:{protectedHomes:this.quotaProtectedHomes,rootIdentity:profile.rootIdentity},command:profile.codexExecutable??this.config.codexExecutable??'codex'}));
    this.legacyQuotaReporter=quotaReporter??null;this.quotaReporter=null;
    const profiles=(config.profiles??[]).map((profile)=>({...profile,localHome:profile.codexHome}));
    const appliedRevision=Number(database.prepare("SELECT value FROM agent_state WHERE key='applied_config_revision'").get()?.value??0);
    this.configureProfiles(profiles,{legacyFallback:profiles.length===0&&(!Number.isSafeInteger(appliedRevision)||appliedRevision===0)});
  }
  configureProfiles(profiles,{legacyFallback=false}={}){
    const selections=this.database?.prepare('SELECT canonical_home FROM existing_home_selections').all()??[];
    const retained=this.database?.prepare('SELECT local_home,mode FROM profile_assignments WHERE local_home IS NOT NULL').all()??[];
    const saved=this.database?.prepare("SELECT value FROM agent_state WHERE key='quota_source_roots'").get()?.value;
    let history=[];
    if(saved){try{history=JSON.parse(saved);if(!Array.isArray(history)||history.some(value=>typeof value!=='string'))throw Error();}catch{history=['/'];}} // Corrupt history disables stale cleanup, never guesses what is disposable.
    this.quotaProtectedHomes=[...new Set([...history,...profiles.map(profile=>profile.localHome??profile.codexHome),...selections.map(row=>row.canonical_home),...retained.map(row=>row.local_home)].filter(Boolean))];
    // Keep local-only source exclusions even after stop/re-add replaces a row.
    // Pure default/isolated installations need no new state or cleanup policy.
    if(this.database&&(saved||selections.length||profiles.some(profile=>profile.mode==='existing')||retained.some(row=>row.mode==='existing'))){
      const value=JSON.stringify(this.quotaProtectedHomes);if(value!==saved)state(this.database,'quota_source_roots',value,this.clock);
    }
    this.profileQuotaReporters=profiles.map((profile)=>{
      const reporter=this.quotaReporterFactory(profile);
      if(profile.mode!=='existing')return reporter;
      // An adopted root can be replaced after attachment. Never launch Codex
      // against a different canonical environment, even when discovery failed.
      const observe=reporter.observe.bind(reporter);
      reporter.observe=async()=>{
        try{await assertExistingQuotaLocation(profile.localHome??profile.codexHome,profile.rootIdentity);}
        catch{return{accountId:profile.accountId,observedAt:new Date(this.clock()).toISOString(),status:'unavailable',errorKind:'write_isolation_failed',planType:null,windows:[]};}
        return observe();
      };
      return reporter;
    });
    if(legacyFallback&&profiles.length===0){this.legacyQuotaReporter??=new QuotaReporter({clock:this.clock,command:this.config.codexExecutable??'codex',codexHome:this.config.codexHome});this.quotaReporter=this.legacyQuotaReporter;}
    else this.quotaReporter=null;
  }
  pending() { return this.database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count; }
  async sync({ heartbeat = false, health = { status: 'healthy' }, collectQuota = true } = {}) {
    const rows = outboxRows(this.database, this.config.maxBatchSize);
    const designated = this.database.prepare("SELECT value FROM agent_state WHERE key='is_quota_reporter'").get()?.value === 'true';
    if (!rows.length && !heartbeat && !designated) return { skipped: true, pending: 0 };
    state(this.database,'last_sync_attempt_at',new Date(this.clock()).toISOString(),this.clock);
    const quotaReport = collectQuota && designated && this.quotaReporter ? await this.quotaReporter.observe() : undefined;
    const quotaReports = collectQuota && heartbeat && this.profileQuotaReporters.length ? await Promise.all(this.profileQuotaReporters.map((reporter) => reporter.observe())) : undefined;
    const attempted = [...(quotaReport ? [quotaReport] : []), ...(quotaReports ?? [])];
    if (attempted.length) {
      state(this.database, 'last_quota_attempt_at', new Date(this.clock()).toISOString(), this.clock);
      const failed=attempted.find((report)=>report.status!=='available');
      state(this.database, 'last_quota_status', failed?.status ?? 'available', this.clock);
      state(this.database, 'last_quota_error_kind', failed?.errorKind ?? '', this.clock);
      for (const report of quotaReports ?? []) profileQuotaState(this.database, report, this.clock);
    }
    const remoteActualState=this.database.prepare("SELECT value FROM agent_state WHERE key='remote_actual_state_supported'").get()?.value==='true';
    const reportedConfiguration=remoteActualState?configurationState(this.database):undefined;
    // Existing Servers have a strict error enum. Preserve the precise local
    // diagnostic without turning a protected probe failure into HTTP 400/offline.
    const compatibleQuota=report=>report?.errorKind==='write_isolation_failed'?{...report,errorKind:'app_server_unavailable'}:report;
    const requestBody={agentVersion:AGENT_VERSION,codexVersion:this.codexVersion,events:rows.map(wire),health,
      ...(quotaReport===undefined?{}:{quotaReport:compatibleQuota(quotaReport)}),...(quotaReports===undefined?{}:{quotaReports:quotaReports.map(compatibleQuota)}),...(reportedConfiguration===undefined?{}:{configurationState:reportedConfiguration})};
    const send=async(payload)=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
      try{return await this.fetch(`${this.config.serverUrl}/api/v1/agent/sync`,{method:'POST',signal:controller.signal,
        headers:{'content-type':'application/json',authorization:`Bearer ${this.config.deviceId}.${this.config.deviceSecret}`,[AGENT_CAPABILITY_HEADER]:AGENT_CAPABILITY_HEADER_VALUE,[EXISTING_HOME_HEADER]:'1','x-codex-meter-opencodex':'1'},body:JSON.stringify(payload)});}
      finally{clearTimeout(timer);}
    };
    let response;
    try {
      response=await send(requestBody);
      if(response.status===403&&quotaReports!==undefined){
        let errorBody=null;try{errorBody=await response.json();}catch{/* retry only a stable structured rejection */}
        if(errorBody?.error==='account_not_bound'){const retryBody={...requestBody};delete retryBody.quotaReports;response=await send(retryBody);}
      }
    } catch (error) {
      state(this.database, 'last_sync_status', 'unavailable', this.clock);
      state(this.database,'last_sync_error_kind','network_unavailable',this.clock);
      throw new Error('agent sync unavailable', { cause: error });
    }
    if (!response.ok) {
      state(this.database, 'last_sync_status', `http_${response.status}`, this.clock);
      let rejection=null;try{rejection=await response.json();}catch{/* Non-JSON proxies are reported only by HTTP status. */}
      const knownErrors=new Set(['invalid_configuration_revision','stale_configuration_revision','missing_configuration_profile','extra_configuration_profile','wrong_configuration_account','wrong_configuration_mode','invalid_configuration_state','configuration_capability_required','account_not_bound','invalid_quota','invalid_quota_time','invalid_events','unauthorized','invalid_device']);
      state(this.database,'last_sync_error_kind',knownErrors.has(rejection?.error)?rejection.error:`http_${response.status}`,this.clock);
      if (response.status === 403 && designated) state(this.database, 'is_quota_reporter', false, this.clock);
      throw new Error(`agent sync failed (${response.status})`);
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('agent sync returned invalid JSON'); }
    const sent = new Set(rows.map((row) => row.event_id));
    const acknowledged = new Set([...(Array.isArray(result.acceptedEventIds) ? result.acceptedEventIds : []),
      ...(Array.isArray(result.duplicateEventIds) ? result.duplicateEventIds : [])].filter((id) => sent.has(id)));
    const permanentlyRejected = new Map();
    if (Array.isArray(result.rejectedEvents)) for (const rejection of result.rejectedEvents) {
      if (!rejection || typeof rejection !== 'object' || Array.isArray(rejection) || Object.keys(rejection).sort().join(',') !== 'eventId,reason') continue;
      if (rejection.reason === 'account_not_bound' && sent.has(rejection.eventId) && !acknowledged.has(rejection.eventId))
        permanentlyRejected.set(rejection.eventId, rejection.reason);
    }
    const serverCapabilities=parseServerCapabilities(result.serverCapabilities);
    const serverCapabilitiesPresent=result.serverCapabilities!==undefined;
    if(serverCapabilities===null){state(this.database,'last_sync_status','protocol_error',this.clock);throw new Error('agent sync returned invalid Server capabilities');}
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.database.prepare('DELETE FROM usage_outbox WHERE event_id=?');
      for (const id of acknowledged) remove.run(id);
      const deadLetter = this.database.prepare('INSERT OR IGNORE INTO usage_dead_letters(event_id,account_id,reason,rejected_at) SELECT event_id,account_id,?,? FROM usage_outbox WHERE event_id=?');
      for (const [eventId, reason] of permanentlyRejected) {
        deadLetter.run(reason, new Date(this.clock()).toISOString(), eventId);
        remove.run(eventId);
      }
      state(this.database, 'last_sync_status', 'ok', this.clock);
      state(this.database,'last_sync_error_kind','',this.clock);
      state(this.database, 'last_sync_at', new Date(this.clock()).toISOString(), this.clock);
      if (result.serverTime) state(this.database, 'last_server_time', result.serverTime, this.clock);
      if(serverCapabilities)
        state(this.database,'remote_declarative_supported','true',this.clock);
      if(serverCapabilities?.actualState===true)state(this.database,'remote_actual_state_supported','true',this.clock);
      if(!serverCapabilitiesPresent){state(this.database,'remote_declarative_supported','false',this.clock);state(this.database,'remote_actual_state_supported','false',this.clock);}
      state(this.database, 'is_quota_reporter', result.isQuotaReporter === true, this.clock);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return { sent: rows.length, acknowledged: acknowledged.size, rejected: permanentlyRejected.size, pending: this.pending(), configuration: serverCapabilities?result.agentConfiguration??null:null,
      isQuotaReporter: result.isQuotaReporter === true, opencodexHub:result.opencodexHub===true };
  }
}
