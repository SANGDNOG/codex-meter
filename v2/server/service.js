import { randomUUID } from 'node:crypto';
import { parseSignedInt64, parseUnsignedInt64 } from '../shared/int64.js';
import { SERVER_CAPABILITIES } from '../shared/capabilities.js';
import { hashPassword, hashSecret, salt, secret, verifyPassword, verifySecret } from './security.js';

const DIMENSIONS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const COLUMNS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const HEALTH = new Set(['healthy', 'degraded', 'error', 'unknown']);
const RANGES = new Set(['today', '7d', '30d', 'all']);
const SAFE_METADATA = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUOTA_STATUSES = new Set(['available', 'ambiguous', 'unavailable']);
const QUOTA_ERROR_KINDS = new Set(['codex_not_found','app_server_timeout','app_server_unavailable','not_authenticated','malformed_rate_limits','ambiguous_limits']);
const PLAN_TYPES = new Set(['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']);
const BINDING_MODES = new Set(['default','isolated','legacy']);
const CONFIG_STATUSES = new Set(['unknown','applying','healthy','apply_failed','migration_attention_required']);
const PROFILE_STATES = new Set(['tracking','login_required','quota_available','quota_unavailable','apply_failed','migration_attention_required','stopped']);

export class ServiceError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}

function fail(status, code, message) { throw new ServiceError(status, code, message); }
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body');
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) fail(400, 'invalid_body');
}
function text(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_field', `invalid ${field}`);
  return value.trim();
}
function nullableText(value, field, max = 100) {
  if (value === null || value === undefined) return null;
  return text(value, field, max);
}
function metadata(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !SAFE_METADATA.test(value)) fail(400, 'invalid_field', `invalid ${field}`);
  return value;
}
function timestamp(value, field = 'timestamp') {
  if (typeof value !== 'string' || value.length > 40) fail(400, 'invalid_field', `invalid ${field}`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(400, 'invalid_field', `invalid ${field}`);
  return new Date(time).toISOString();
}
function encodeQuotaCursor(observedAt, observationId) {
  return Buffer.from(`${observedAt}\u0000${observationId}`, 'utf8').toString('base64url');
}
function parseQuotaCursor(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, 'invalid_cursor');
  let decoded;
  try {
    const bytes=Buffer.from(value,'base64url');
    if(bytes.toString('base64url')!==value)fail(400,'invalid_cursor');
    decoded=bytes.toString('utf8');
  } catch(error) { if(error instanceof ServiceError)throw error;fail(400,'invalid_cursor'); }
  const parts=decoded.split('\u0000');
  if(parts.length!==2)fail(400,'invalid_cursor');
  const parsedTime=Date.parse(parts[0]);
  if(!Number.isFinite(parsedTime)||new Date(parsedTime).toISOString()!==parts[0]||!/^[A-Za-z0-9_-]{1,128}$/.test(parts[1]))fail(400,'invalid_cursor');
  return{observedAt:parts[0],observationId:parts[1]};
}
function parseQuotaReport(value) {
  exact(value, ['observedAt','status','planType','windows'],['errorKind']);
  const observedAt=timestamp(value.observedAt,'observedAt');
  if(!QUOTA_STATUSES.has(value.status)) fail(400,'invalid_quota');
  let planType=null;
  if(value.planType!==null){if(typeof value.planType!=='string'||!PLAN_TYPES.has(value.planType))fail(400,'invalid_quota');planType=value.planType;}
  if(!Array.isArray(value.windows)||value.windows.length>32) fail(400,'invalid_quota');
  const windows=value.windows.map((window)=>{
    exact(window,['limitId','durationMinutes','usedPercent','resetsAt','slot']);
    const limitId=metadata(window.limitId,'limitId'); if(!limitId) fail(400,'invalid_quota');
    if(!Number.isSafeInteger(window.durationMinutes)||window.durationMinutes<=0) fail(400,'invalid_quota');
    if(typeof window.usedPercent!=='number'||!Number.isFinite(window.usedPercent)||window.usedPercent<0||window.usedPercent>100) fail(400,'invalid_quota');
    const resetsAt=window.resetsAt===null?null:timestamp(window.resetsAt,'resetsAt'); const slot=window.slot===null?null:metadata(window.slot,'slot');
    return{limitId,durationMinutes:window.durationMinutes,usedPercent:window.usedPercent,resetsAt,slot};
  });
  const identities=windows.map((window)=>`${window.limitId}\u0000${window.durationMinutes}`);
  if(new Set(identities).size!==identities.length) fail(400,'invalid_quota');
  if((value.status==='available')!==Boolean(windows.length)) fail(400,'invalid_quota');
  const errorKind=value.errorKind===undefined?null:value.errorKind;
  if(errorKind!==null&&!QUOTA_ERROR_KINDS.has(errorKind))fail(400,'invalid_quota');
  if(value.status==='available'&&errorKind!==null)fail(400,'invalid_quota');
  if(value.status==='ambiguous'&&errorKind!=='ambiguous_limits')fail(400,'invalid_quota');
  if(value.status==='unavailable'&&errorKind==='ambiguous_limits')fail(400,'invalid_quota');
  return{observedAt,status:value.status,errorKind,planType,windows};
}
function parseCapabilities(value) {
  if(value===undefined)return{agentConfigurationSchema:null,declarativeProfiles:false,actualState:false};
  exact(value,['agentConfigurationSchema','declarativeProfiles','actualState']);
  if(value.agentConfigurationSchema!==1||value.declarativeProfiles!==true||typeof value.actualState!=='boolean')fail(400,'invalid_capabilities');
  return value;
}
function parseConfigurationState(value) {
  if(value===undefined)return null;
  exact(value,['desiredRevision','appliedRevision','status','errorKind','profiles']);
  if(!Number.isSafeInteger(value.desiredRevision)||value.desiredRevision<0||!Number.isSafeInteger(value.appliedRevision)||value.appliedRevision<0||value.appliedRevision>value.desiredRevision||!CONFIG_STATUSES.has(value.status))fail(400,'invalid_configuration_state');
  const errorKind=value.errorKind===null?null:metadata(value.errorKind,'errorKind');
  if(value.status==='healthy'&&value.appliedRevision!==value.desiredRevision)fail(400,'invalid_configuration_state');
  if(value.status==='apply_failed'&&(!errorKind||value.appliedRevision===value.desiredRevision))fail(400,'invalid_configuration_state');
  if(!Array.isArray(value.profiles)||value.profiles.length>64)fail(400,'invalid_configuration_state');
  const profiles=value.profiles.map((profile)=>{exact(profile,['bindingId','accountId','mode','state'],['launcher']);if(!['default','isolated','preserve'].includes(profile.mode)||!PROFILE_STATES.has(profile.state))fail(400,'invalid_configuration_state');return{bindingId:id(profile.bindingId,'bindingId'),accountId:id(profile.accountId,'accountId'),mode:profile.mode,state:profile.state,launcher:profile.launcher===undefined?null:metadata(profile.launcher,'launcher')};});
  if(new Set(profiles.map((profile)=>profile.bindingId)).size!==profiles.length)fail(400,'invalid_configuration_state');
  return{desiredRevision:value.desiredRevision,appliedRevision:value.appliedRevision,status:value.status,errorKind,profiles};
}
function id(value, field = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(400, 'invalid_field', `invalid ${field}`);
  return value;
}
function nowIso(clock) { return new Date(clock()).toISOString(); }
function tx(database, callback) {
  database.exec('BEGIN IMMEDIATE');
  try { const result = callback(); database.exec('COMMIT'); return result; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}
function rowsBig(database, sql, ...params) {
  const statement = database.prepare(sql); statement.setReadBigInts(true); return statement.all(...params);
}
const QUOTA_PERCENT_SCALE = 1_000_000n;
function quotaCycleBoundary(resetsAt, durationMinutes) {
  if (typeof resetsAt !== 'string' || !Number.isSafeInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > Math.floor(Number.MAX_SAFE_INTEGER / 60_000)) return null;
  const resetMs = Date.parse(resetsAt); const durationMs = durationMinutes * 60_000;
  if (!Number.isFinite(resetMs) || !Number.isSafeInteger(durationMs)) return null;
  const startMs = resetMs - durationMs;
  if (!Number.isFinite(startMs) || startMs >= resetMs) return null;
  try { return { cycleStart: new Date(startMs).toISOString(), resetsAt: new Date(resetMs).toISOString(), resetMs }; } catch { return null; }
}
function quotaRatioPercent(part, total) {
  if (total === 0n) return null;
  const scaled = (part * 100n * QUOTA_PERCENT_SCALE + total / 2n) / total;
  return Number(scaled) / Number(QUOTA_PERCENT_SCALE);
}
function quotaContribution(basisPercentagePoints, part, total) {
  if (total === 0n || typeof basisPercentagePoints !== 'number' || !Number.isFinite(basisPercentagePoints)) return null;
  const basis = BigInt(Math.round(basisPercentagePoints * Number(QUOTA_PERCENT_SCALE)));
  const scaled = (basis * part + total / 2n) / total;
  return Number(scaled) / Number(QUOTA_PERCENT_SCALE);
}
function tokenObject(row, prefix = '') {
  const result = {};
  for (let index = 0; index < DIMENSIONS.length; index += 1) {
    const value = row[`${prefix}${COLUMNS[index]}`];
    result[DIMENSIONS[index]] = value === null || value === undefined ? null : value.toString();
  }
  return result;
}
function zeroDimensions() { return Object.fromEntries(DIMENSIONS.map((key) => [key, 0n])); }
function addMeasured(target, row) {
  for (let index = 0; index < DIMENSIONS.length; index += 1) if (row[COLUMNS[index]] !== null) target[DIMENSIONS[index]] += row[COLUMNS[index]];
}
function wireDimensions(values) { return Object.fromEntries(DIMENSIONS.map((key) => [key, values[key].toString()])); }
function groupWire(row) { return { id: row.id, name: row.name, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function accountWire(row) { return { id: row.id, name: row.name, reference: Boolean(row.reference), archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function bindingWire(row) { return { id: row.id, deviceId: row.device_id, accountId: row.account_id, mode: row.mode === 'legacy' ? 'preserve' : row.mode, createdAt: row.created_at, disabledAt: row.disabled_at }; }
function membershipAt(database, deviceId, occurredAt) {
  return database.prepare(`SELECT group_id FROM device_group_memberships
    WHERE device_id = ? AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)
    ORDER BY valid_from DESC LIMIT 1`).get(deviceId, occurredAt, occurredAt)?.group_id ?? null;
}
function bindingAt(database, deviceId, accountId, occurredAt) {
  return database.prepare(`SELECT b.id FROM device_account_bindings b JOIN accounts a ON a.id=b.account_id
    WHERE b.device_id=? AND b.account_id=? AND (b.mode='legacy' OR b.created_at<=?) AND (b.disabled_at IS NULL OR b.disabled_at>?)
      AND (a.archived_at IS NULL OR a.archived_at>?) ORDER BY b.created_at DESC LIMIT 1`).get(deviceId,accountId,occurredAt,occurredAt,occurredAt);
}
function closeOpenMembership(database, deviceId, at) {
  const open = database.prepare('SELECT id, valid_from FROM device_group_memberships WHERE device_id=? AND valid_until IS NULL').get(deviceId);
  if (!open) return at;
  const effectiveAt = open.valid_from >= at ? new Date(Date.parse(open.valid_from) + 1).toISOString() : at;
  database.prepare('UPDATE device_group_memberships SET valid_until=? WHERE id=?').run(effectiveAt, open.id);
  return effectiveAt;
}
function timezoneTodayStart(now, zone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const target = `${parts.year}-${parts.month}-${parts.day}`;
    let guess = Date.parse(`${target}T00:00:00.000Z`);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const local = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
      const p = Object.fromEntries(local.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      guess += Date.parse(`${target}T00:00:00.000Z`) - represented;
    }
    return new Date(guess).toISOString();
  } catch { fail(400, 'invalid_timezone'); }
}

export class MeterService {
  constructor(database, { adminPassword, serverUrl = '', clock = Date.now, enrollmentTtlMs = 15 * 60_000, sessionTtlMs = 12 * 60 * 60_000, quotaStaleMs = 5 * 60_000, quotaFutureSkewMs = 5 * 60_000 } = {}) {
    this.database = database; this.serverUrl = serverUrl; this.clock = clock; this.enrollmentTtlMs = enrollmentTtlMs; this.sessionTtlMs = sessionTtlMs;
    if(!Number.isSafeInteger(quotaStaleMs)||quotaStaleMs<1000) throw new Error('invalid quotaStaleMs'); this.quotaStaleMs=quotaStaleMs;
    if(!Number.isSafeInteger(quotaFutureSkewMs)||quotaFutureSkewMs<0) throw new Error('invalid quotaFutureSkewMs'); this.quotaFutureSkewMs=quotaFutureSkewMs;
    const auth = database.prepare('SELECT singleton FROM admin_auth WHERE singleton = 1').get();
    if (!auth) {
      if (!adminPassword) throw new Error('adminPassword is required for first startup');
      const passwordSalt = salt();
      database.prepare('INSERT INTO admin_auth (singleton, password_hash, password_salt, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
        .run(hashPassword(adminPassword, passwordSalt), passwordSalt, nowIso(clock), nowIso(clock));
    }
  }

  login(password) {
    const row = this.database.prepare('SELECT password_hash, password_salt FROM admin_auth WHERE singleton = 1').get();
    if (!verifyPassword(password, row.password_salt, row.password_hash)) fail(401, 'invalid_credentials');
    const raw = secret(); const tokenSalt = salt(); const csrf = secret(24); const now = nowIso(this.clock);
    this.database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
    this.database.prepare('INSERT INTO admin_sessions (id, token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), hashSecret(raw, tokenSalt), `${tokenSalt}.${csrf}`, new Date(this.clock() + this.sessionTtlMs).toISOString(), now);
    return { token: raw, csrfToken: csrf };
  }

  session(raw) {
    if (typeof raw !== 'string') return null;
    const now = nowIso(this.clock);
    for (const row of this.database.prepare('SELECT id, token_hash, csrf_token, expires_at FROM admin_sessions WHERE expires_at > ?').all(now)) {
      const [tokenSalt, csrf] = row.csrf_token.split('.', 2);
      if (verifySecret(raw, tokenSalt, row.token_hash)) return { id: row.id, csrfToken: csrf, expiresAt: row.expires_at };
    }
    return null;
  }
  logout(sessionId) { this.database.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sessionId); }

  listGroups() { return this.database.prepare('SELECT * FROM groups ORDER BY name, id').all().map(groupWire); }

  listAccounts(rangeValue = 'all') {
    return this.database.prepare('SELECT * FROM accounts ORDER BY name,id').all().map((row) => {
      const devices=this.database.prepare('SELECT COUNT(*) count FROM device_account_bindings WHERE account_id=? AND disabled_at IS NULL').get(row.id).count;
      return {...accountWire(row),devices,measured:this.usage(rangeValue,{accountId:row.id}).measured,quota:this.accountQuota(row.id)};
    });
  }
  accountDetail(accountId, rangeValue = 'all') {
    id(accountId, 'accountId');
    const row = this.database.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
    if (!row) fail(404, 'account_not_found');
    const devices = this.database.prepare(`SELECT b.*,d.name device_name FROM device_account_bindings b
      JOIN devices d ON d.id=b.device_id WHERE b.account_id=? ORDER BY d.name,d.id`).all(accountId).map((binding) => ({
      ...bindingWire(binding), name: binding.device_name,
      measured: this.usage(rangeValue, { accountId, deviceId: binding.device_id }).measured
    }));
    const groups = this.database.prepare(`SELECT DISTINCT g.id,g.name FROM usage_events u JOIN groups g ON g.id=u.resolved_group_id
      WHERE u.account_id=? ORDER BY g.name,g.id`).all(accountId).map((group) => ({
      id: group.id, name: group.name, measured: this.usage(rangeValue, { accountId, groupId: group.id }).measured
    }));
    const unassigned = this.usage(rangeValue, { accountId, unassigned: true }).measured;
    return { ...accountWire(row), measured: this.usage(rangeValue, { accountId }).measured, devices, groups, unassigned, quota: this.accountQuota(accountId) };
  }
  createAccount(body) {
    exact(body,['name'],['reference']); if('reference'in body&&typeof body.reference!=='boolean')fail(400,'invalid_field');
    const now=nowIso(this.clock),account={id:randomUUID(),name:text(body.name,'name'),reference:body.reference===true,archivedAt:null,createdAt:now,updatedAt:now};
    try{this.database.prepare('INSERT INTO accounts(id,name,reference,created_at,updated_at) VALUES(?,?,?,?,?)').run(account.id,account.name,account.reference?1:0,now,now);}catch(error){if(String(error).includes('UNIQUE'))fail(409,account.reference?'reference_exists':'account_name_exists');throw error;}return account;
  }
  updateAccount(accountId,body){
    id(accountId,'accountId');exact(body,[],['name','reference','archived']);if(!Object.keys(body).length)fail(400,'invalid_body');const row=this.database.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);if(!row)fail(404,'account_not_found');
    if('reference'in body&&typeof body.reference!=='boolean')fail(400,'invalid_field');if('archived'in body&&typeof body.archived!=='boolean')fail(400,'invalid_field');
    const name='name'in body?text(body.name,'name'):row.name,reference='reference'in body?(body.reference?1:0):row.reference,archived='archived'in body?(body.archived?nowIso(this.clock):null):row.archived_at,now=nowIso(this.clock);
    try{tx(this.database,()=>{this.database.prepare('UPDATE accounts SET name=?,reference=?,archived_at=?,updated_at=? WHERE id=?').run(name,reference,archived,now,accountId);if(name!==row.name||archived!==row.archived_at)this.publishAccountDeviceConfigurations(accountId);});}
    catch(error){if(String(error).includes('UNIQUE'))fail(409,reference?'reference_exists':'account_name_exists');throw error;}return accountWire(this.database.prepare('SELECT * FROM accounts WHERE id=?').get(accountId));
  }
  publishDeviceConfiguration(deviceId,{sourceRevision=null}={}){
    const now=nowIso(this.clock),device=this.database.prepare('SELECT desired_config_revision FROM devices WHERE id=?').get(deviceId);if(!device)fail(404,'device_not_found');
    const revision=device.desired_config_revision+1;
    this.database.prepare('UPDATE devices SET desired_config_revision=?,updated_at=? WHERE id=?').run(revision,now,deviceId);
    this.database.prepare(`INSERT INTO device_configuration_revisions(device_id,revision,schema_version,sync_interval_seconds,heartbeat_interval_seconds,max_batch_size,created_at)
      VALUES(?,?,1,15,60,100,?)`).run(deviceId,revision,now);
    if(sourceRevision===null){
      this.database.prepare(`INSERT INTO device_configuration_revision_profiles(device_id,revision,binding_id,account_id,name,mode)
        SELECT b.device_id,?,b.id,b.account_id,a.name,b.mode FROM device_account_bindings b JOIN accounts a ON a.id=b.account_id
        WHERE b.device_id=? AND b.disabled_at IS NULL AND a.archived_at IS NULL ORDER BY b.created_at,b.id`).run(revision,deviceId);
    }else{
      if(!Number.isSafeInteger(sourceRevision)||sourceRevision<1)fail(400,'invalid_configuration_revision');
      const source=this.database.prepare('SELECT 1 FROM device_configuration_revisions WHERE device_id=? AND revision=?').get(deviceId,sourceRevision);if(!source)fail(404,'configuration_revision_not_found');
      this.database.prepare(`INSERT INTO device_configuration_revision_profiles(device_id,revision,binding_id,account_id,name,mode)
        SELECT device_id,?,binding_id,account_id,name,mode FROM device_configuration_revision_profiles WHERE device_id=? AND revision=? ORDER BY binding_id`).run(revision,deviceId,sourceRevision);
    }
    return revision;
  }
  publishAccountDeviceConfigurations(accountId){
    const deviceIds=this.database.prepare('SELECT DISTINCT device_id FROM device_account_bindings WHERE account_id=? AND disabled_at IS NULL ORDER BY device_id').all(accountId);
    for(const {device_id:deviceId} of deviceIds)this.publishDeviceConfiguration(deviceId);
  }
  rollbackConfiguration(deviceId,body){
    id(deviceId,'deviceId');exact(body,['revision']);return tx(this.database,()=>({revision:this.publishDeviceConfiguration(deviceId,{sourceRevision:body.revision})}));
  }
  bindAccount(deviceId,body){
    id(deviceId,'deviceId');this.deviceDetail(deviceId);exact(body,['accountId'],['mode','codexHomeKey']);const accountId=id(body.accountId,'accountId');
    const mode=body.mode===undefined?'legacy':body.mode;if(!BINDING_MODES.has(mode)||mode==='legacy'&&body.codexHomeKey===undefined&&body.mode!==undefined)fail(400,'invalid_mode');
    if(body.codexHomeKey!==undefined&&!metadata(body.codexHomeKey,'codexHomeKey'))fail(400,'invalid_field');
    if(!this.database.prepare('SELECT id FROM accounts WHERE id=? AND archived_at IS NULL').get(accountId))fail(400,'invalid_account');const now=nowIso(this.clock),binding={id:randomUUID(),deviceId,accountId,mode:mode==='legacy'?'preserve':mode,createdAt:now,disabledAt:null};
    try{tx(this.database,()=>{this.database.prepare('INSERT INTO device_account_bindings(id,device_id,account_id,codex_home_key,mode,created_at) VALUES(?,?,?,?,?,?)').run(binding.id,deviceId,accountId,body.codexHomeKey??randomUUID(),mode,now);this.publishDeviceConfiguration(deviceId);});}catch(error){if(String(error).includes('UNIQUE'))fail(409,'binding_exists_or_mode_conflict');throw error;}return binding;
  }
  disableBinding(deviceId,bindingId){
    id(deviceId,'deviceId');id(bindingId,'bindingId');const row=this.database.prepare('SELECT * FROM device_account_bindings WHERE id=? AND device_id=?').get(bindingId,deviceId);if(!row)fail(404,'binding_not_found');
    if(row.disabled_at)return bindingWire(row);const now=nowIso(this.clock);tx(this.database,()=>{this.database.prepare('UPDATE device_account_bindings SET disabled_at=? WHERE id=?').run(now,bindingId);this.publishDeviceConfiguration(deviceId);});return bindingWire(this.database.prepare('SELECT * FROM device_account_bindings WHERE id=?').get(bindingId));
  }
  activeBinding(deviceId,accountId){return this.database.prepare(`SELECT b.id FROM device_account_bindings b JOIN accounts a ON a.id=b.account_id WHERE b.device_id=? AND b.account_id=? AND b.disabled_at IS NULL AND a.archived_at IS NULL`).get(deviceId,accountId);}
  desiredConfiguration(deviceId){
    const device=this.database.prepare('SELECT desired_config_revision FROM devices WHERE id=?').get(deviceId);if(!device)fail(404,'device_not_found');
    if(device.desired_config_revision===0)return{schemaVersion:1,revision:0,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles:[]};
    const revision=this.database.prepare('SELECT * FROM device_configuration_revisions WHERE device_id=? AND revision=?').get(deviceId,device.desired_config_revision);if(!revision)fail(500,'configuration_revision_missing');
    const profiles=this.database.prepare(`SELECT binding_id,account_id,name,mode FROM device_configuration_revision_profiles WHERE device_id=? AND revision=? ORDER BY binding_id`).all(deviceId,revision.revision)
      .map((row)=>({bindingId:row.binding_id,accountId:row.account_id,name:row.name,mode:row.mode==='legacy'?'preserve':row.mode}));
    return{schemaVersion:revision.schema_version,revision:revision.revision,syncIntervalSeconds:revision.sync_interval_seconds,heartbeatIntervalSeconds:revision.heartbeat_interval_seconds,maxBatchSize:revision.max_batch_size,profiles};
  }
  createGroup(body) {
    exact(body, ['name']); const now = nowIso(this.clock); const group = { id: randomUUID(), name: text(body.name, 'name'), archivedAt: null, createdAt: now, updatedAt: now };
    try { this.database.prepare('INSERT INTO groups (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(group.id, group.name, now, now); }
    catch (error) { if (String(error).includes('UNIQUE')) fail(409, 'group_name_exists'); throw error; }
    return group;
  }
  updateGroup(groupId, body) {
    id(groupId); exact(body, [], ['name', 'archived']); if (!('name' in body) && !('archived' in body)) fail(400, 'invalid_body');
    const row = this.database.prepare('SELECT * FROM groups WHERE id=?').get(groupId); if (!row) fail(404, 'group_not_found');
    const name = 'name' in body ? text(body.name, 'name') : row.name;
    if ('archived' in body && typeof body.archived !== 'boolean') fail(400, 'invalid_field');
    const archived = 'archived' in body ? (body.archived ? nowIso(this.clock) : null) : row.archived_at; const now = nowIso(this.clock);
    try { this.database.prepare('UPDATE groups SET name=?, archived_at=?, updated_at=? WHERE id=?').run(name, archived, now, groupId); }
    catch (error) { if (String(error).includes('UNIQUE')) fail(409, 'group_name_exists'); throw error; }
    return groupWire(this.database.prepare('SELECT * FROM groups WHERE id=?').get(groupId));
  }

  createDevice(body) {
    exact(body, ['name'], ['groupId', 'expiresInSeconds','accountId','mode']); const name = text(body.name, 'name'); const groupId = body.groupId == null ? null : id(body.groupId, 'groupId');
    if (groupId && !this.database.prepare('SELECT id FROM groups WHERE id=? AND archived_at IS NULL').get(groupId)) fail(400, 'invalid_group');
    const accountId=body.accountId==null?null:id(body.accountId,'accountId');if(accountId&&!this.database.prepare('SELECT id FROM accounts WHERE id=? AND archived_at IS NULL').get(accountId))fail(400,'invalid_account');
    const mode=accountId?(body.mode??'default'):null;if(mode!==null&&!['default','isolated'].includes(mode))fail(400,'invalid_mode');if(!accountId&&body.mode!==undefined)fail(400,'invalid_mode');
    let ttl = this.enrollmentTtlMs;
    if ('expiresInSeconds' in body) { if (!Number.isInteger(body.expiresInSeconds) || body.expiresInSeconds < 1 || body.expiresInSeconds > 3600) fail(400, 'invalid_field'); ttl = body.expiresInSeconds * 1000; }
    const raw = secret(); const tokenSalt = salt(); const enrollmentId = randomUUID(); const createdAt = nowIso(this.clock); const expiresAt = new Date(this.clock() + ttl).toISOString();
    this.database.prepare('INSERT INTO device_enrollments (id,device_name,group_id,token_hash,expires_at,created_at,token_salt,account_id,binding_mode) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(enrollmentId, name, groupId, hashSecret(raw, tokenSalt), expiresAt, createdAt, tokenSalt,accountId,mode);
    return { enrollmentId, enrollmentToken: raw, expiresAt, deviceName: name, groupId, accountId, mode };
  }

  enroll(body, capabilitiesValue) {
    exact(body, ['token']); const raw = text(body.token, 'token', 200); const now = nowIso(this.clock);
    const declarative=parseCapabilities(capabilitiesValue).declarativeProfiles;
    return tx(this.database, () => {
      let enrollment = null;
      for (const row of this.database.prepare('SELECT * FROM device_enrollments WHERE consumed_at IS NULL').all()) {
        if (row.token_salt && verifySecret(raw, row.token_salt, row.token_hash)) { enrollment = row; break; }
      }
      if (!enrollment) fail(401, 'invalid_enrollment');
      if (enrollment.expires_at <= now) fail(410, 'enrollment_expired');
      const consumed = this.database.prepare('UPDATE device_enrollments SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now, enrollment.id);
      if (consumed.changes !== 1) fail(409, 'enrollment_used');
      const deviceId = randomUUID(); const deviceSecret = secret(); const credentialSalt = salt();
      this.database.prepare(`INSERT INTO devices (id,name,credential_hash,credential_salt,current_group_id,desired_config_revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(deviceId, enrollment.device_name, hashSecret(deviceSecret, credentialSalt), credentialSalt, enrollment.group_id,0, now, now);
      if (enrollment.group_id) this.database.prepare('INSERT INTO device_group_memberships (id,device_id,group_id,valid_from) VALUES (?,?,?,?)')
        .run(randomUUID(), deviceId, enrollment.group_id, now);
      if(enrollment.account_id){this.database.prepare('INSERT INTO device_account_bindings(id,device_id,account_id,codex_home_key,mode,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),deviceId,enrollment.account_id,randomUUID(),enrollment.binding_mode,now);this.publishDeviceConfiguration(deviceId);}
      this.database.prepare('UPDATE device_enrollments SET device_id=? WHERE id=?').run(deviceId, enrollment.id);
      return { deviceId, deviceSecret, serverUrl: this.serverUrl, agentConfiguration: declarative?this.desiredConfiguration(deviceId):this.configuration(),
        ...(declarative?{serverCapabilities:SERVER_CAPABILITIES}:{}) };
    });
  }

  authenticateDevice(deviceId, raw) {
    if (typeof deviceId !== 'string' || typeof raw !== 'string') return null;
    const row = this.database.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    if (!row || row.disabled_at || row.removed_at || !row.credential_salt || !verifySecret(raw, row.credential_salt, row.credential_hash)) return null;
    return row;
  }
  configuration() { return { syncIntervalSeconds: 15, heartbeatIntervalSeconds: 60, maxBatchSize: 100 }; }

  listDevices() { return this.database.prepare(`SELECT d.*, g.name group_name FROM devices d LEFT JOIN groups g ON g.id=d.current_group_id
    WHERE d.removed_at IS NULL ORDER BY d.name,d.id`).all().map((row) => this.deviceWire(row)); }
  deviceThresholds() {
    const settings=this.settings();
    return {onlineSeconds:Number(settings.onlineThresholdSeconds),staleSeconds:Number(settings.staleThresholdSeconds)};
  }
  deviceState(row) {
    if(row.disabled_at)return'disabled'; if(!row.last_seen_at)return'offline';
    const age=(this.clock()-Date.parse(row.last_seen_at))/1000,{onlineSeconds,staleSeconds}=this.deviceThresholds();
    return age<onlineSeconds?'online':age<=staleSeconds?'stale':'offline';
  }
  deviceWire(row) { const desired=row.desired_config_revision??0,applied=row.applied_config_revision??0,reported=row.configuration_status??'unknown';return { id: row.id, name: row.name, currentGroupId: row.current_group_id, currentGroupName: row.group_name ?? null, disabledAt: row.disabled_at, removedAt: row.removed_at, lastSeenAt: row.last_seen_at, state:this.deviceState(row), agentVersion: row.agent_version, codexVersion: row.codex_version, health: row.health_status ?? 'unknown', desiredRevision:desired, appliedRevision:applied, configurationStatus:row.declarative_profiles_supported?(applied<desired&&reported==='healthy'?'applying':reported):'unsupported', configurationErrorKind:row.configuration_error_kind??null, configurationReportedAt:row.configuration_reported_at??null, createdAt: row.created_at, updatedAt: row.updated_at }; }
  enrollmentStatus(enrollmentId) {
    id(enrollmentId,'enrollmentId'); const row=this.database.prepare('SELECT id,expires_at,device_id FROM device_enrollments WHERE id=?').get(enrollmentId);
    if(!row)fail(404,'enrollment_not_found');
    return {enrollmentId:row.id,expiresAt:row.expires_at,status:row.device_id?'connected':(row.expires_at<=nowIso(this.clock)?'expired':'pending'),deviceId:row.device_id??null};
  }
  deviceDetail(deviceId) {
    id(deviceId); const row = this.database.prepare(`SELECT d.*,g.name group_name FROM devices d LEFT JOIN groups g ON g.id=d.current_group_id WHERE d.id=? AND d.removed_at IS NULL`).get(deviceId);
    if (!row) fail(404, 'device_not_found');
    const memberships = this.database.prepare(`SELECT m.group_id groupId,g.name groupName,m.valid_from validFrom,m.valid_until validUntil
      FROM device_group_memberships m JOIN groups g ON g.id=m.group_id WHERE m.device_id=? ORDER BY m.valid_from`).all(deviceId).map((r)=>({...r}));
    const profiles=this.database.prepare(`SELECT b.*,a.name,a.reference,a.archived_at account_archived_at FROM device_account_bindings b JOIN accounts a ON a.id=b.account_id WHERE b.device_id=? ORDER BY a.name`).all(deviceId).map((binding)=>({
      ...bindingWire(binding),name:binding.name,reference:Boolean(binding.reference),accountArchivedAt:binding.account_archived_at,measured:this.usage('all',{deviceId,accountId:binding.account_id}).measured,
      actual:this.database.prepare('SELECT state,launcher_name launcher,reported_at reportedAt FROM device_profile_status WHERE device_id=? AND binding_id=?').get(deviceId,binding.id)??null
    }));
    return { ...this.deviceWire(row), memberships, profiles };
  }
  updateDevice(deviceId, body) {
    id(deviceId); exact(body, ['name']); this.deviceDetail(deviceId); const now=nowIso(this.clock);
    this.database.prepare('UPDATE devices SET name=?,updated_at=? WHERE id=?').run(text(body.name,'name'),now,deviceId); return this.deviceDetail(deviceId);
  }
  moveDevice(deviceId, body) {
    id(deviceId); exact(body, ['groupId']); const groupId = body.groupId === null ? null : id(body.groupId,'groupId'); const device=this.deviceDetail(deviceId);
    if (groupId && !this.database.prepare('SELECT id FROM groups WHERE id=? AND archived_at IS NULL').get(groupId)) fail(400,'invalid_group');
    if (device.currentGroupId === groupId) return device; let now=nowIso(this.clock);
    tx(this.database,()=>{
      now = closeOpenMembership(this.database, deviceId, now);
      if(groupId) this.database.prepare('INSERT INTO device_group_memberships (id,device_id,group_id,valid_from) VALUES (?,?,?,?)').run(randomUUID(),deviceId,groupId,now);
      this.database.prepare('UPDATE devices SET current_group_id=?,updated_at=? WHERE id=?').run(groupId,now,deviceId);
    }); return this.deviceDetail(deviceId);
  }
  disableDevice(deviceId, disabled=true) { id(deviceId); if(typeof disabled!=='boolean') fail(400,'invalid_field'); this.deviceDetail(deviceId); const now=nowIso(this.clock); this.database.prepare('UPDATE devices SET disabled_at=?,updated_at=? WHERE id=?').run(disabled?now:null,now,deviceId); return this.deviceDetail(deviceId); }
  rotateDevice(deviceId) { id(deviceId); this.deviceDetail(deviceId); const raw=secret(); const credentialSalt=salt(); const now=nowIso(this.clock); this.database.prepare('UPDATE devices SET credential_hash=?,credential_salt=?,updated_at=? WHERE id=?').run(hashSecret(raw,credentialSalt),credentialSalt,now,deviceId); return {deviceId,deviceSecret:raw}; }
  removeDevice(deviceId) { id(deviceId); this.deviceDetail(deviceId); const now=nowIso(this.clock); tx(this.database,()=>{ closeOpenMembership(this.database, deviceId, now); const discardedSecret=secret(); const discardedSalt=salt(); this.database.prepare(`UPDATE devices SET removed_at=?,disabled_at=coalesce(disabled_at,?),current_group_id=NULL,credential_hash=?,credential_salt=?,updated_at=? WHERE id=?`).run(now,now,hashSecret(discardedSecret,discardedSalt),discardedSalt,now,deviceId); }); }

  sync(device, body, capabilitiesValue) {
    exact(body, ['agentVersion','codexVersion','events','health'],['quotaReport','quotaReports','configurationState']);
    const capabilities=parseCapabilities(capabilitiesValue),configurationState=parseConfigurationState(body.configurationState);
    if(configurationState&&!capabilities.actualState)fail(400,'configuration_capability_required');
    if(configurationState&&configurationState.desiredRevision>device.desired_config_revision)fail(400,'invalid_configuration_revision');
    if(configurationState){
      const expected=configurationState.appliedRevision===0?[]:this.database.prepare(`SELECT binding_id,account_id,mode FROM device_configuration_revision_profiles
        WHERE device_id=? AND revision=? ORDER BY binding_id`).all(device.id,configurationState.appliedRevision);
      if(configurationState.appliedRevision>0&&!this.database.prepare('SELECT 1 FROM device_configuration_revisions WHERE device_id=? AND revision=?').get(device.id,configurationState.appliedRevision))fail(400,'stale_configuration_revision');
      const byBinding=new Map(expected.map((row)=>[row.binding_id,row]));
      const reportedIds=new Set(configurationState.profiles.map((profile)=>profile.bindingId));
      if(expected.some((row)=>!reportedIds.has(row.binding_id)))fail(400,'missing_configuration_profile');
      if(configurationState.profiles.some((profile)=>!byBinding.has(profile.bindingId)))fail(400,'extra_configuration_profile');
      for(const profile of configurationState.profiles){const binding=byBinding.get(profile.bindingId),mode=binding.mode==='legacy'?'preserve':binding.mode;if(binding.account_id!==profile.accountId)fail(400,'wrong_configuration_account');if(mode!==profile.mode)fail(400,'wrong_configuration_mode');}
    }
    const reporter=this.database.prepare("SELECT value FROM server_settings WHERE key='quota_reporter_device_id'").get()?.value??null;
    if('quotaReport'in body&&reporter!==device.id) fail(403,'not_quota_reporter');
    const quota='quotaReport'in body?parseQuotaReport(body.quotaReport):null;
    if(quota&&Date.parse(quota.observedAt)>this.clock()+this.quotaFutureSkewMs)fail(400,'invalid_quota_time');
    if('quotaReports'in body&&(!Array.isArray(body.quotaReports)||body.quotaReports.length>64))fail(400,'invalid_quota');
    const profileQuotas=(body.quotaReports??[]).map((report)=>{exact(report,['accountId','observedAt','status','planType','windows'],['errorKind']);const accountId=id(report.accountId,'accountId');if(!this.activeBinding(device.id,accountId))fail(403,'account_not_bound');const quota=parseQuotaReport({observedAt:report.observedAt,status:report.status,planType:report.planType,windows:report.windows,...(report.errorKind===undefined?{}:{errorKind:report.errorKind})});if(Date.parse(quota.observedAt)>this.clock()+this.quotaFutureSkewMs)fail(400,'invalid_quota_time');return{accountId,quota};});
    if(new Set(profileQuotas.map((report)=>report.accountId)).size!==profileQuotas.length)fail(400,'duplicate_account_quota');
    const agentVersion=nullableText(body.agentVersion,'agentVersion',64), codexVersion=nullableText(body.codexVersion,'codexVersion',64);
    if(!Array.isArray(body.events)||body.events.length>100) fail(400,'invalid_events');
    exact(body.health,['status']); if(!HEALTH.has(body.health.status)) fail(400,'invalid_health');
    const rejected=[];
    const events=body.events.map((event)=>{
      exact(event,['eventId','occurredAt','inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'],['model','reasoningEffort','accountId']);
      const accountId=event.accountId===undefined?null:id(event.accountId,'accountId');
      const parsed={eventId:id(event.eventId,'eventId'),accountId,occurredAt:timestamp(event.occurredAt,'occurredAt'),model:metadata(event.model,'model'),reasoningEffort:metadata(event.reasoningEffort,'reasoningEffort')};
      for(const key of DIMENSIONS){ if(event[key]===null && key!=='totalTokens') parsed[key]=null; else { try{parsed[key]=parseUnsignedInt64(event[key]);}catch{fail(400,'invalid_tokens');} } }
      if(accountId&&!bindingAt(this.database,device.id,accountId,parsed.occurredAt)){rejected.push({eventId:parsed.eventId,reason:'account_not_bound'});return null;}
      return parsed;
    });
    const eventIds=body.events.map((event)=>event.eventId);if(new Set(eventIds).size!==eventIds.length)fail(400,'duplicate_event_id_in_batch');
    const acceptedEvents=events.filter(Boolean);
    const accepted=[],duplicate=[],receivedAt=nowIso(this.clock);
    tx(this.database,()=>{
      for(const event of acceptedEvents){
        const exists=this.database.prepare('SELECT 1 FROM usage_events WHERE device_id=? AND event_id=?').get(device.id,event.eventId);
        if(exists){duplicate.push(event.eventId);continue;}
        const groupId=membershipAt(this.database,device.id,event.occurredAt);
        this.database.prepare(`INSERT INTO usage_events (id,device_id,event_id,occurred_at,received_at,resolved_group_id,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,model,reasoning_effort,account_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),device.id,event.eventId,event.occurredAt,receivedAt,groupId,event.inputTokens,event.cachedInputTokens,event.cacheWriteInputTokens,event.outputTokens,event.reasoningOutputTokens,event.totalTokens,event.model,event.reasoningEffort,event.accountId);
        accepted.push(event.eventId);
      }
      this.database.prepare(`UPDATE devices SET last_seen_at=?,agent_version=?,codex_version=?,health_status=?,agent_configuration_schema=?,declarative_profiles_supported=?,actual_state_supported=?,updated_at=? WHERE id=?`)
        .run(receivedAt,agentVersion,codexVersion,body.health.status,capabilities.agentConfigurationSchema,capabilities.declarativeProfiles?1:0,capabilities.actualState?1:0,receivedAt,device.id);
      if(configurationState){
        this.database.prepare('UPDATE devices SET applied_config_revision=?,configuration_status=?,configuration_error_kind=?,configuration_reported_at=? WHERE id=?').run(configurationState.appliedRevision,configurationState.status,configurationState.errorKind,receivedAt,device.id);
        this.database.prepare('DELETE FROM device_profile_status WHERE device_id=?').run(device.id);
        const insertStatus=this.database.prepare('INSERT INTO device_profile_status(device_id,binding_id,account_id,mode,state,launcher_name,reported_at) VALUES(?,?,?,?,?,?,?)');
        for(const profile of configurationState.profiles)insertStatus.run(device.id,profile.bindingId,profile.accountId,profile.mode,profile.state,profile.launcher,receivedAt);
      }
      if(quota)this.replaceQuota(device.id,quota);
      for(const report of profileQuotas)this.replaceAccountQuota(device.id,report.accountId,report.quota);
    });
    return {acceptedEventIds:accepted,duplicateEventIds:duplicate,rejectedEvents:rejected,serverTime:receivedAt,agentConfiguration:capabilities.declarativeProfiles?this.desiredConfiguration(device.id):this.configuration(),
      ...(capabilities.declarativeProfiles?{serverCapabilities:SERVER_CAPABILITIES}:{}),isQuotaReporter:reporter===device.id};
  }

  replaceQuota(deviceId,quota){
    const observationId=randomUUID();const existing=this.database.prepare('SELECT observed_at FROM quota_current LIMIT 1').get();const replace=!existing||Date.parse(quota.observedAt)>Date.parse(existing.observed_at);
    if(replace)this.database.prepare('DELETE FROM quota_current').run();
    const current=this.database.prepare(`INSERT INTO quota_current(identity_key,reporter_device_id,observed_at,plan_type,limit_id,duration_minutes,used_percent,resets_at,slot,status,error_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const snapshot=this.database.prepare(`INSERT INTO quota_snapshots(observation_id,reporter_device_id,observed_at,plan_type,limit_id,duration_minutes,used_percent,resets_at,slot,status,error_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const rows=quota.windows.length?quota.windows:[{limitId:null,durationMinutes:null,usedPercent:null,resetsAt:null,slot:null}];
    for(const window of rows){const identity=window.limitId===null?'':`${window.limitId}\u0000${window.durationMinutes}`;const params=[deviceId,quota.observedAt,quota.planType,window.limitId,window.durationMinutes,window.usedPercent,window.resetsAt,window.slot,quota.status,quota.errorKind];if(replace)current.run(identity,...params);snapshot.run(observationId,...params);}
  }
  quotaCurrent(){
    const reference=this.database.prepare('SELECT id FROM accounts WHERE reference=1 AND archived_at IS NULL LIMIT 1').get();
    if(reference){const result=this.accountQuota(reference.id);return{...result,accountId:reference.id};}
    const reporter=this.database.prepare("SELECT value FROM server_settings WHERE key='quota_reporter_device_id'").get()?.value??null;
    const rows=this.database.prepare('SELECT * FROM quota_current ORDER BY limit_id,duration_minutes').all();
    if(!reporter)return{observedAt:null,status:'unavailable',reporterState:'no_reporter',reporterDeviceId:null,errorKind:null,planType:null,windows:[]};
    const reporterRow=this.database.prepare('SELECT * FROM devices WHERE id=?').get(reporter);const online=reporterRow&&this.deviceState(reporterRow)==='online';
    if(!rows.length||rows[0].reporter_device_id!==reporter)return{observedAt:null,status:'unavailable',reporterState:online?'collection_failed':'reporter_offline',reporterDeviceId:reporter,errorKind:null,planType:null,windows:[]};
    const sourceStatus=rows[0].status;const stale=this.clock()-Date.parse(rows[0].observed_at)>this.quotaStaleMs;
    const reporterState=!online?'reporter_offline':stale?'stale_observation':sourceStatus==='available'?'available':'collection_failed';
    return{observedAt:rows[0].observed_at,status:stale?'stale':sourceStatus,...(stale?{sourceStatus}:{}),reporterState,reporterDeviceId:reporter,errorKind:rows[0].error_kind??null,planType:rows[0].plan_type,windows:rows.filter((row)=>row.limit_id!==null).map((row)=>({limitId:row.limit_id,durationMinutes:row.duration_minutes,usedPercent:row.used_percent,resetsAt:row.resets_at,slot:row.slot}))};
  }
  replaceAccountQuota(deviceId, accountId, quota) {
    const observationId=randomUUID();
    const current=this.database.prepare(`INSERT INTO account_quota_current(account_id,identity_key,reporter_device_id,observed_at,plan_type,limit_id,duration_minutes,used_percent,resets_at,slot,status,error_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const snapshot=this.database.prepare(`INSERT INTO account_quota_snapshots(observation_id,account_id,reporter_device_id,observed_at,plan_type,limit_id,duration_minutes,used_percent,resets_at,slot,status,error_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const rows=quota.windows.length?quota.windows:[{limitId:null,durationMinutes:null,usedPercent:null,resetsAt:null,slot:null}];
    const existing=this.database.prepare('SELECT observed_at FROM account_quota_current WHERE account_id=? LIMIT 1').get(accountId);
    const replace=!existing||Date.parse(quota.observedAt)>Date.parse(existing.observed_at);
    if(replace)this.database.prepare('DELETE FROM account_quota_current WHERE account_id=?').run(accountId);
    for(const window of rows){const identity=window.limitId===null?'':`${window.limitId}\u0000${window.durationMinutes}`;const params=[accountId,deviceId,quota.observedAt,quota.planType,window.limitId,window.durationMinutes,window.usedPercent,window.resetsAt,window.slot,quota.status,quota.errorKind];if(replace)current.run(accountId,identity,deviceId,quota.observedAt,quota.planType,window.limitId,window.durationMinutes,window.usedPercent,window.resetsAt,window.slot,quota.status,quota.errorKind);snapshot.run(observationId,...params);}
  }
  accountQuota(accountId){
    id(accountId,'accountId');const rows=this.database.prepare('SELECT * FROM account_quota_current WHERE account_id=? ORDER BY limit_id,duration_minutes').all(accountId);
    const reporters=this.database.prepare(`SELECT d.* FROM device_account_bindings b JOIN devices d ON d.id=b.device_id WHERE b.account_id=? AND b.disabled_at IS NULL AND d.disabled_at IS NULL AND d.removed_at IS NULL`).all(accountId);const anyReporterOnline=reporters.some((row)=>this.deviceState(row)==='online');
    if(!rows.length)return{observedAt:null,status:'unavailable',reporterState:!reporters.length?'no_reporter':anyReporterOnline?'collection_failed':'reporter_offline',reporterDeviceId:null,errorKind:null,planType:null,windows:[]};
    const reporterEligible=reporters.some((row)=>row.id===rows[0].reporter_device_id);
    if(!reporterEligible)return{observedAt:rows[0].observed_at,status:'unavailable',reporterState:!reporters.length?'no_reporter':anyReporterOnline?'collection_failed':'reporter_offline',reporterDeviceId:null,errorKind:rows[0].error_kind??null,planType:rows[0].plan_type,windows:rows.filter((row)=>row.limit_id!==null).map((row)=>({limitId:row.limit_id,durationMinutes:row.duration_minutes,usedPercent:row.used_percent,resetsAt:row.resets_at,slot:row.slot}))};
    const stale=this.clock()-Date.parse(rows[0].observed_at)>this.quotaStaleMs;
    const reporter=this.database.prepare('SELECT * FROM devices WHERE id=?').get(rows[0].reporter_device_id);const online=reporter&&this.deviceState(reporter)==='online';const reporterState=!online?'reporter_offline':stale?'stale_observation':rows[0].status==='available'?'available':'collection_failed';
    return{observedAt:rows[0].observed_at,status:stale?'stale':rows[0].status,...(stale?{sourceStatus:rows[0].status}:{}),reporterState,reporterDeviceId:rows[0].reporter_device_id,errorKind:rows[0].error_kind??null,planType:rows[0].plan_type,windows:rows.filter((row)=>row.limit_id!==null).map((row)=>({limitId:row.limit_id,durationMinutes:row.duration_minutes,usedPercent:row.used_percent,resetsAt:row.resets_at,slot:row.slot}))};
  }
  accountQuotaHistory(accountId,{limit=100,before=null}={}){
    id(accountId,'accountId');if(!this.database.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId))fail(404,'account_not_found');
    if(!Number.isInteger(limit)||limit<1||limit>500)fail(400,'invalid_limit');const boundary=before===null?null:parseQuotaCursor(before);
    const rows=this.database.prepare(`SELECT observation_id,observed_at FROM account_quota_snapshots WHERE account_id=? ${boundary?'AND (observed_at < ? OR (observed_at = ? AND observation_id < ?))':''} GROUP BY observation_id,observed_at ORDER BY observed_at DESC,observation_id DESC LIMIT ?`).all(...(boundary?[accountId,boundary.observedAt,boundary.observedAt,boundary.observationId,limit+1]:[accountId,limit+1]));
    const hasMore=rows.length>limit,observations=rows.slice(0,limit);
    const statement=this.database.prepare('SELECT * FROM account_quota_snapshots WHERE account_id=? AND observation_id=? ORDER BY limit_id,duration_minutes');
    const result=observations.map((observation)=>{const observationRows=statement.all(accountId,observation.observation_id);const first=observationRows[0];return{observationId:observation.observation_id,observedAt:first.observed_at,status:first.status,errorKind:first.error_kind??null,reporterDeviceId:first.reporter_device_id,planType:first.plan_type,windows:observationRows.filter((row)=>row.limit_id!==null).map((row)=>({limitId:row.limit_id,durationMinutes:row.duration_minutes,usedPercent:row.used_percent,resetsAt:row.resets_at,slot:row.slot}))};});
    const last=observations.at(-1);
    return{observations:result,nextCursor:hasMore?encodeQuotaCursor(last.observed_at,last.observation_id):null};
  }

  quotaAttribution(accountId) {
    id(accountId,'accountId');
    if(!this.database.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId))fail(404,'account_not_found');
    const quota=this.accountQuota(accountId),now=this.clock();
    const currentRows=this.database.prepare('SELECT * FROM account_quota_current WHERE account_id=? AND limit_id IS NOT NULL ORDER BY limit_id,duration_minutes').all(accountId);
    const candidates=[];
    for(const row of currentRows)candidates.push({...row,fromCurrent:true});
    if(!candidates.length){
      const history=this.database.prepare(`SELECT * FROM account_quota_snapshots WHERE account_id=? AND status='available' AND limit_id IS NOT NULL ORDER BY observed_at DESC,id DESC`).all(accountId);
      const seen=new Set();
      for(const row of history){
        const key=`${row.limit_id}\u0000${row.duration_minutes}`;
        if(seen.has(key))continue;
        const boundary=quotaCycleBoundary(row.resets_at,row.duration_minutes);
        if(!boundary||boundary.resetMs<=now)continue;
        seen.add(key);candidates.push({...row,fromCurrent:false});
      }
      candidates.sort((a,b)=>a.limit_id.localeCompare(b.limit_id)||a.duration_minutes-b.duration_minutes);
    }
    const legacyEventsPresent=Boolean(this.database.prepare('SELECT 1 FROM usage_events WHERE account_id IS NULL LIMIT 1').get());
    const historicalGroups=this.database.prepare(`SELECT DISTINCT g.id,g.name FROM usage_events u JOIN groups g ON g.id=u.resolved_group_id WHERE u.account_id=? ORDER BY g.name,g.id`).all(accountId);
    const windows=candidates.map((candidate)=>{
      const providerCurrent=candidate.fromCurrent&&candidate.status==='available'&&(quota.status==='available'||(quota.status==='stale'&&quota.sourceStatus==='available'));
      const base={limitId:candidate.limit_id,durationMinutes:candidate.duration_minutes,slot:candidate.slot??null,usedPercent:providerCurrent?candidate.used_percent:null,resetsAt:candidate.resets_at??null,cycleStart:null,coverage:{status:'unknown',from:null,baselineUsedPercent:null},estimate:{status:'unavailable',basisPercentagePoints:null,semantics:null,basedOnObservedAt:quota.observedAt,reason:'cycle_boundary_unknown'},tracked:{from:null,to:null,totalTokens:null},groups:[]};
      const boundary=quotaCycleBoundary(candidate.resets_at,candidate.duration_minutes);
      if(!boundary)return base;
      if(boundary.resetMs<=now){base.usedPercent=null;base.resetsAt=null;base.estimate.reason='quota_snapshot_expired';return base;}
      base.resetsAt=boundary.resetsAt;base.cycleStart=boundary.cycleStart;
      const cycleRows=this.database.prepare(`SELECT * FROM account_quota_snapshots WHERE account_id=? AND limit_id=? AND duration_minutes=? AND status='available' AND resets_at=? AND observed_at>=? AND observed_at<? ORDER BY observed_at,id`).all(accountId,candidate.limit_id,candidate.duration_minutes,boundary.resetsAt,boundary.cycleStart,boundary.resetsAt);
      if(!cycleRows.length)return base;
      const earliestAt=cycleRows[0].observed_at;
      const baselineRows=cycleRows.filter((row)=>row.observed_at===earliestAt);
      const baselineValues=new Set(baselineRows.map((row)=>row.used_percent));
      const transitionConflict=Boolean(this.database.prepare(`SELECT 1 FROM account_quota_snapshots WHERE account_id=? AND limit_id=? AND duration_minutes=? AND status='available' AND observed_at=? AND (resets_at IS NULL OR resets_at<>?) LIMIT 1`).get(accountId,candidate.limit_id,candidate.duration_minutes,earliestAt,boundary.resetsAt));
      if(baselineValues.size!==1||transitionConflict){
        base.estimate={...base.estimate,status:'ambiguous',reason:'baseline_conflict'};
        return base;
      }
      const baselineUsedPercent=baselineRows[0].used_percent;
      const preceding=this.database.prepare(`SELECT * FROM account_quota_snapshots WHERE account_id=? AND limit_id=? AND duration_minutes=? AND status='available' AND observed_at<? ORDER BY observed_at DESC,id DESC LIMIT 1`).get(accountId,candidate.limit_id,candidate.duration_minutes,earliestAt);
      const priorBoundary=preceding&&quotaCycleBoundary(preceding.resets_at,preceding.duration_minutes);
      const priorCycle=Boolean(
        priorBoundary?.resetsAt===boundary.cycleStart&&
        Date.parse(preceding.observed_at)<=Date.parse(boundary.cycleStart)
      );
      const coverageStatus=priorCycle?'full':'partial';
      const coverageFrom=priorCycle?boundary.cycleStart:(earliestAt<boundary.cycleStart?boundary.cycleStart:earliestAt);
      base.coverage={status:coverageStatus,from:coverageFrom,baselineUsedPercent:coverageStatus==='partial'?baselineUsedPercent:null};
      const trackedTo=new Date(Math.min(now,boundary.resetMs)).toISOString();
      const eventRows=rowsBig(this.database,`SELECT resolved_group_id,total_tokens FROM usage_events WHERE account_id=? AND occurred_at>=? AND occurred_at<=?`,accountId,coverageFrom,trackedTo);
      const totals=new Map();let total=0n;
      for(const row of eventRows){const key=row.resolved_group_id??null;const value=row.total_tokens??0n;totals.set(key,(totals.get(key)??0n)+value);total+=value;}
      base.tracked={from:coverageFrom,to:trackedTo,totalTokens:total.toString()};
      const semantics=coverageStatus==='full'?'full_cycle':'since_tracking_began';
      let basis=providerCurrent?(coverageStatus==='full'?candidate.used_percent:candidate.used_percent-baselineUsedPercent):null;
      let estimateStatus='unavailable',reason=providerCurrent?null:'provider_quota_unavailable';
      if(providerCurrent&&basis<0){basis=null;estimateStatus='ambiguous';reason='provider_used_percent_regressed';}
      else if(providerCurrent&&total===0n){estimateStatus='no_tracked_usage';reason='no_tracked_usage';}
      else if(providerCurrent){estimateStatus=quota.status==='stale'?'stale':'available';reason=estimateStatus==='stale'?'stale_quota_snapshot':null;}
      base.estimate={status:estimateStatus,basisPercentagePoints:basis,semantics,basedOnObservedAt:quota.observedAt,reason};
      const groups=historicalGroups.map((group)=>({group:{id:group.id,name:group.name},label:group.name,trackedTokens:(totals.get(group.id)??0n).toString()}));
      groups.push({group:null,label:'Unassigned',trackedTokens:(totals.get(null)??0n).toString()});
      base.groups=groups.map((entry)=>{const tokens=BigInt(entry.trackedTokens);return{...entry,trackedSharePercent:quotaRatioPercent(tokens,total),estimatedQuotaContributionPercentagePoints:estimateStatus==='available'||estimateStatus==='stale'?quotaContribution(basis,tokens,total):null};});
      return base;
    });
    const hasCurrentCycle=windows.some((window)=>window.cycleStart!==null);
    const quotaStatus=!hasCurrentCycle&&(quota.status==='available'||quota.status==='stale')?'unavailable':quota.status;
    const quotaWire={observedAt:quota.observedAt,status:quotaStatus,reporterState:quota.reporterState,reporterDeviceId:quota.reporterDeviceId,errorKind:quota.errorKind,planType:quota.planType,...('sourceStatus'in quota?{sourceStatus:quota.sourceStatus}:{})};
    return{accountId,quota:quotaWire,windows,warnings:['estimated_not_provider_attributed','untracked_usage_may_affect_estimate',...(legacyEventsPresent?['legacy_unattributed_events_exist']:[])]};
  }

  range(value) {
    if(!RANGES.has(value)) fail(400,'invalid_range'); const end=nowIso(this.clock); if(value==='all') return {range:value,start:null,end};
    if(value==='today'){const zone=this.database.prepare("SELECT value FROM server_settings WHERE key='timezone'").get()?.value??'UTC';return {range:value,start:timezoneTodayStart(new Date(this.clock()),zone),end};}
    return {range:value,start:new Date(this.clock()-(value==='7d'?7:30)*86400000).toISOString(),end};
  }
  usage(rangeValue,{groupId=null,deviceId=null,accountId=undefined,unassigned=false}={}) {
    const range=this.range(rangeValue); const clauses=['occurred_at <= ?'], params=[range.end]; if(range.start){clauses.push('occurred_at >= ?');params.push(range.start);} if(groupId!==undefined&&groupId!==false&&groupId!==null){clauses.push('resolved_group_id = ?');params.push(groupId);} if(unassigned)clauses.push('resolved_group_id IS NULL'); if(deviceId){clauses.push('device_id = ?');params.push(deviceId);} if(accountId!==undefined){if(accountId===null)clauses.push('account_id IS NULL');else{clauses.push('account_id = ?');params.push(id(accountId,'accountId'));}}
    const measuredRows=rowsBig(this.database,`SELECT * FROM usage_events WHERE ${clauses.join(' AND ')}`,...params);
    let adjustmentSql='SELECT * FROM usage_adjustments WHERE occurred_at <= ?', adjustmentParams=[range.end]; if(range.start){adjustmentSql+=' AND occurred_at >= ?';adjustmentParams.push(range.start);} if(groupId!==null){adjustmentSql+=' AND group_id = ?';adjustmentParams.push(groupId);} if(deviceId){adjustmentSql+=' AND device_id = ?';adjustmentParams.push(deviceId);} if(accountId!==undefined)adjustmentSql+=' AND 0';
    const adjustmentRows=rowsBig(this.database,adjustmentSql,...adjustmentParams); const measured=zeroDimensions(); for(const row of measuredRows)addMeasured(measured,row); let adjusted=0n;for(const row of adjustmentRows)adjusted+=row.amount_tokens;
    return {range,measured:wireDimensions(measured),adjusted:{totalTokens:adjusted.toString()},combined:{totalTokens:(measured.totalTokens+adjusted).toString()}};
  }
  summary(rangeValue) {
    const overall=this.usage(rangeValue); const groups=this.listGroups(); const denominator=BigInt(overall.combined.totalTokens); const entries=groups.map((group)=>({group,...this.usage(rangeValue,{groupId:group.id})}));
    const unassigned=this.usageUnassigned(rangeValue);
    const percent=(part,total)=>total!==0n?Number((BigInt(part)*1000000n)/total)/10000:0;
    const addShares=(entry)=>{const shares={measured:percent(entry.measured.totalTokens,BigInt(overall.measured.totalTokens)),adjusted:percent(entry.adjusted.totalTokens,BigInt(overall.adjusted.totalTokens)),combined:percent(entry.combined.totalTokens,denominator)};return{...entry,shares,share:shares.combined};};
    const withShares=[...entries.map(addShares),addShares({group:null,...unassigned})];
    return {...overall,groups:withShares};
  }
  usageUnassigned(rangeValue){const range=this.range(rangeValue);const clauses=['occurred_at <= ?','resolved_group_id IS NULL'],params=[range.end];if(range.start){clauses.push('occurred_at >= ?');params.push(range.start);}const measuredRows=rowsBig(this.database,`SELECT * FROM usage_events WHERE ${clauses.join(' AND ')}`,...params);const adjustmentSql=`SELECT * FROM usage_adjustments WHERE occurred_at <= ? ${range.start?'AND occurred_at >= ? ':''}AND group_id IS NULL`;const adj=rowsBig(this.database,adjustmentSql,...(range.start?[range.end,range.start]:[range.end]));const measured=zeroDimensions();for(const row of measuredRows)addMeasured(measured,row);let adjusted=0n;for(const row of adj)adjusted+=row.amount_tokens;return{range,measured:wireDimensions(measured),adjusted:{totalTokens:adjusted.toString()},combined:{totalTokens:(measured.totalTokens+adjusted).toString()}};}
  addAdjustment(body,adminSessionId){exact(body,['amountTokens','reason','occurredAt'],['groupId','deviceId']);let amount;try{amount=parseSignedInt64(body.amountTokens);}catch{fail(400,'invalid_tokens');}if(amount===0n)fail(400,'invalid_tokens');const occurredAt=timestamp(body.occurredAt,'occurredAt');const deviceId=body.deviceId==null?null:id(body.deviceId,'deviceId');const resolvedDeviceGroup=deviceId?membershipAt(this.database,deviceId,occurredAt):null;let groupId=body.groupId===undefined?resolvedDeviceGroup:(body.groupId===null?null:id(body.groupId,'groupId'));if(deviceId&&!this.database.prepare('SELECT id FROM devices WHERE id=?').get(deviceId))fail(400,'invalid_device');if(deviceId&&'groupId'in body&&groupId!==resolvedDeviceGroup)fail(400,'group_device_mismatch');if(groupId&&!this.database.prepare('SELECT id FROM groups WHERE id=?').get(groupId))fail(400,'invalid_group');const adjustment={id:randomUUID(),groupId,deviceId,amountTokens:amount.toString(),reason:text(body.reason,'reason',500),occurredAt,createdAt:nowIso(this.clock),createdBySessionId:adminSessionId};this.database.prepare('INSERT INTO usage_adjustments (id,group_id,device_id,amount_tokens,reason,occurred_at,created_at,created_by_session_id) VALUES (?,?,?,?,?,?,?,?)').run(adjustment.id,groupId,deviceId,amount,adjustment.reason,occurredAt,adjustment.createdAt,adminSessionId);return adjustment;}

  settings(){
    const names={quota_reporter_device_id:'quotaReporterDeviceId',online_threshold_seconds:'onlineThresholdSeconds',stale_threshold_seconds:'staleThresholdSeconds'};
    const rows=this.database.prepare('SELECT key,value FROM server_settings').all();return Object.fromEntries(rows.map((r)=>[names[r.key]??r.key,r.value]));
  }
  updateSettings(body){
    exact(body,[],['timezone','quotaReporterDeviceId','onlineThresholdSeconds','staleThresholdSeconds']);if(!Object.keys(body).length)fail(400,'invalid_body');const now=nowIso(this.clock);
    if('timezone'in body){text(body.timezone,'timezone',100);timezoneTodayStart(new Date(this.clock()),body.timezone);this.database.prepare(`INSERT INTO server_settings(key,value,updated_at) VALUES('timezone',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(body.timezone,now);}
    if('quotaReporterDeviceId'in body){const value=body.quotaReporterDeviceId;if(value!==null&&(!this.database.prepare('SELECT id FROM devices WHERE id=? AND removed_at IS NULL AND disabled_at IS NULL').get(id(value))))fail(400,'invalid_device');if(value===null)this.database.prepare("DELETE FROM server_settings WHERE key='quota_reporter_device_id'").run();else this.database.prepare(`INSERT INTO server_settings(key,value,updated_at) VALUES('quota_reporter_device_id',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(value,now);this.database.prepare('DELETE FROM quota_current').run();}
    if('onlineThresholdSeconds'in body||'staleThresholdSeconds'in body){const current=this.deviceThresholds();const online='onlineThresholdSeconds'in body?body.onlineThresholdSeconds:current.onlineSeconds;const stale='staleThresholdSeconds'in body?body.staleThresholdSeconds:current.staleSeconds;if(!Number.isInteger(online)||!Number.isInteger(stale)||online<10||stale>86400||online>=stale)fail(400,'invalid_thresholds');const upsert=this.database.prepare(`INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);upsert.run('online_threshold_seconds',String(online),now);upsert.run('stale_threshold_seconds',String(stale),now);}
    return this.settings();
  }
  health(){return{status:'ok',database:'ok',serverTime:nowIso(this.clock)};}
}
