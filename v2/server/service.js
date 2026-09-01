import { randomUUID } from 'node:crypto';
import { parseSignedInt64, parseUnsignedInt64 } from '../shared/int64.js';
import { hashPassword, hashSecret, salt, secret, verifyPassword, verifySecret } from './security.js';

const DIMENSIONS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const COLUMNS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const HEALTH = new Set(['healthy', 'degraded', 'error', 'unknown']);
const RANGES = new Set(['today', '7d', '30d', 'all']);
const SAFE_METADATA = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUOTA_STATUSES = new Set(['available', 'ambiguous', 'unavailable']);
const QUOTA_ERROR_KINDS = new Set(['codex_not_found','app_server_timeout','app_server_unavailable','not_authenticated','malformed_rate_limits','ambiguous_limits']);
const PLAN_TYPES = new Set(['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']);

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
function bindingWire(row) { return { id: row.id, deviceId: row.device_id, accountId: row.account_id, codexHomeKey: row.codex_home_key, createdAt: row.created_at, disabledAt: row.disabled_at }; }
function membershipAt(database, deviceId, occurredAt) {
  return database.prepare(`SELECT group_id FROM device_group_memberships
    WHERE device_id = ? AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)
    ORDER BY valid_from DESC LIMIT 1`).get(deviceId, occurredAt, occurredAt)?.group_id ?? null;
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
    try{this.database.prepare('UPDATE accounts SET name=?,reference=?,archived_at=?,updated_at=? WHERE id=?').run(name,reference,archived,now,accountId);}catch(error){if(String(error).includes('UNIQUE'))fail(409,reference?'reference_exists':'account_name_exists');throw error;}return accountWire(this.database.prepare('SELECT * FROM accounts WHERE id=?').get(accountId));
  }
  bindAccount(deviceId,body){
    id(deviceId,'deviceId');this.deviceDetail(deviceId);exact(body,['accountId','codexHomeKey']);const accountId=id(body.accountId,'accountId'),key=metadata(body.codexHomeKey,'codexHomeKey');if(!key)fail(400,'invalid_field');
    if(!this.database.prepare('SELECT id FROM accounts WHERE id=? AND archived_at IS NULL').get(accountId))fail(400,'invalid_account');const now=nowIso(this.clock),binding={id:randomUUID(),deviceId,accountId,codexHomeKey:key,createdAt:now,disabledAt:null};
    try{this.database.prepare('INSERT INTO device_account_bindings(id,device_id,account_id,codex_home_key,created_at) VALUES(?,?,?,?,?)').run(binding.id,deviceId,accountId,key,now);}catch(error){if(String(error).includes('UNIQUE'))fail(409,'binding_exists_or_home_reused');throw error;}return binding;
  }
  disableBinding(deviceId,bindingId){id(deviceId,'deviceId');id(bindingId,'bindingId');const now=nowIso(this.clock),result=this.database.prepare('UPDATE device_account_bindings SET disabled_at=coalesce(disabled_at,?) WHERE id=? AND device_id=?').run(now,bindingId,deviceId);if(!result.changes)fail(404,'binding_not_found');return bindingWire(this.database.prepare('SELECT * FROM device_account_bindings WHERE id=?').get(bindingId));}
  activeBinding(deviceId,accountId){return this.database.prepare(`SELECT b.id FROM device_account_bindings b JOIN accounts a ON a.id=b.account_id WHERE b.device_id=? AND b.account_id=? AND b.disabled_at IS NULL AND a.archived_at IS NULL`).get(deviceId,accountId);}
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
    exact(body, ['name'], ['groupId', 'expiresInSeconds']); const name = text(body.name, 'name'); const groupId = body.groupId == null ? null : id(body.groupId, 'groupId');
    if (groupId && !this.database.prepare('SELECT id FROM groups WHERE id=? AND archived_at IS NULL').get(groupId)) fail(400, 'invalid_group');
    let ttl = this.enrollmentTtlMs;
    if ('expiresInSeconds' in body) { if (!Number.isInteger(body.expiresInSeconds) || body.expiresInSeconds < 1 || body.expiresInSeconds > 3600) fail(400, 'invalid_field'); ttl = body.expiresInSeconds * 1000; }
    const raw = secret(); const tokenSalt = salt(); const enrollmentId = randomUUID(); const createdAt = nowIso(this.clock); const expiresAt = new Date(this.clock() + ttl).toISOString();
    this.database.prepare('INSERT INTO device_enrollments (id,device_name,group_id,token_hash,expires_at,created_at,token_salt) VALUES (?,?,?,?,?,?,?)')
      .run(enrollmentId, name, groupId, hashSecret(raw, tokenSalt), expiresAt, createdAt, tokenSalt);
    return { enrollmentId, enrollmentToken: raw, expiresAt, deviceName: name, groupId };
  }

  enroll(body) {
    exact(body, ['token']); const raw = text(body.token, 'token', 200); const now = nowIso(this.clock);
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
      this.database.prepare(`INSERT INTO devices (id,name,credential_hash,credential_salt,current_group_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(deviceId, enrollment.device_name, hashSecret(deviceSecret, credentialSalt), credentialSalt, enrollment.group_id, now, now);
      if (enrollment.group_id) this.database.prepare('INSERT INTO device_group_memberships (id,device_id,group_id,valid_from) VALUES (?,?,?,?)')
        .run(randomUUID(), deviceId, enrollment.group_id, now);
      this.database.prepare('UPDATE device_enrollments SET device_id=? WHERE id=?').run(deviceId, enrollment.id);
      return { deviceId, deviceSecret, serverUrl: this.serverUrl, agentConfiguration: this.configuration() };
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
  deviceWire(row) { return { id: row.id, name: row.name, currentGroupId: row.current_group_id, currentGroupName: row.group_name ?? null, disabledAt: row.disabled_at, removedAt: row.removed_at, lastSeenAt: row.last_seen_at, state:this.deviceState(row), agentVersion: row.agent_version, codexVersion: row.codex_version, health: row.health_status ?? 'unknown', createdAt: row.created_at, updatedAt: row.updated_at }; }
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
      ...bindingWire(binding),name:binding.name,reference:Boolean(binding.reference),accountArchivedAt:binding.account_archived_at,measured:this.usage('all',{deviceId,accountId:binding.account_id}).measured
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

  sync(device, body) {
    exact(body, ['agentVersion','codexVersion','events','health'],['quotaReport','quotaReports']);
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
      if(accountId&&!this.activeBinding(device.id,accountId)){rejected.push({eventId:parsed.eventId,reason:'account_not_bound'});return null;}
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
      this.database.prepare('UPDATE devices SET last_seen_at=?,agent_version=?,codex_version=?,health_status=?,updated_at=? WHERE id=?').run(receivedAt,agentVersion,codexVersion,body.health.status,receivedAt,device.id);
      if(quota)this.replaceQuota(device.id,quota);
      for(const report of profileQuotas)this.replaceAccountQuota(device.id,report.accountId,report.quota);
    });
    return {acceptedEventIds:accepted,duplicateEventIds:duplicate,rejectedEvents:rejected,serverTime:receivedAt,agentConfiguration:this.configuration(),isQuotaReporter:reporter===device.id};
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
    if(!rows.length){const reporters=this.database.prepare(`SELECT d.* FROM device_account_bindings b JOIN devices d ON d.id=b.device_id WHERE b.account_id=? AND b.disabled_at IS NULL AND d.disabled_at IS NULL AND d.removed_at IS NULL`).all(accountId);const online=reporters.some((row)=>this.deviceState(row)==='online');return{observedAt:null,status:'unavailable',reporterState:!reporters.length?'no_reporter':online?'collection_failed':'reporter_offline',reporterDeviceId:null,errorKind:null,planType:null,windows:[]};}
    const stale=this.clock()-Date.parse(rows[0].observed_at)>this.quotaStaleMs;
    const reporter=this.database.prepare('SELECT * FROM devices WHERE id=?').get(rows[0].reporter_device_id);const online=reporter&&this.deviceState(reporter)==='online';const reporterState=!online?'reporter_offline':stale?'stale_observation':rows[0].status==='available'?'available':'collection_failed';
    return{observedAt:rows[0].observed_at,status:stale?'stale':rows[0].status,...(stale?{sourceStatus:rows[0].status}:{}),reporterState,reporterDeviceId:rows[0].reporter_device_id,errorKind:rows[0].error_kind??null,planType:rows[0].plan_type,windows:rows.filter((row)=>row.limit_id!==null).map((row)=>({limitId:row.limit_id,durationMinutes:row.duration_minutes,usedPercent:row.used_percent,resetsAt:row.resets_at,slot:row.slot}))};
  }
  accountQuotaHistory(accountId,{limit=100,before=null}={}){
    id(accountId,'accountId');if(!this.database.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId))fail(404,'account_not_found');
    if(!Number.isInteger(limit)||limit<1||limit>500)fail(400,'invalid_limit');const boundary=before===null?null:timestamp(before,'before');
    const observations=this.database.prepare(`SELECT observation_id,MAX(observed_at) observed_at FROM account_quota_snapshots WHERE account_id=? ${boundary?'AND observed_at < ?':''} GROUP BY observation_id ORDER BY observed_at DESC,observation_id DESC LIMIT ?`).all(...(boundary?[accountId,boundary,limit]:[accountId,limit]));
    const statement=this.database.prepare('SELECT * FROM account_quota_snapshots WHERE account_id=? AND observation_id=? ORDER BY limit_id,duration_minutes');
    return{observations:observations.map((observation)=>{const rows=statement.all(accountId,observation.observation_id);const first=rows[0];return{observationId:observation.observation_id,observedAt:first.observed_at,status:first.status,errorKind:first.error_kind??null,reporterDeviceId:first.reporter_device_id,planType:first.plan_type,windows:rows.filter((row)=>row.limit_id!==null).map((row)=>({limitId:row.limit_id,durationMinutes:row.duration_minutes,usedPercent:row.used_percent,resetsAt:row.resets_at,slot:row.slot}))};})};
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
