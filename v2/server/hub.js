import { randomUUID } from 'node:crypto';
import { HUB_RANGES, exactHub, validateHubUsage, validateHubQuota } from '../shared/hub-snapshot.js';

export class HubService {
  constructor(service,ErrorType){this.service=service;this.db=service.database;this.ErrorType=ErrorType;}
  fail(status,code){throw new this.ErrorType(status,code);}
  bind(deviceId,accountId,{withinTransaction=false}={}){
    if(!this.db.prepare("SELECT id FROM accounts WHERE id=? AND measurement_source='opencodex_proxy' AND archived_at IS NULL").get(accountId))this.fail(400,'invalid_account');
    if(!this.db.prepare('SELECT id FROM devices WHERE id=? AND removed_at IS NULL').get(deviceId))this.fail(404,'device_not_found');
    if(this.db.prepare('SELECT 1 FROM hub_profile_bindings WHERE account_id=? AND disabled_at IS NULL').get(accountId))this.fail(409,'hub_reporter_already_bound');
    const binding={id:randomUUID(),deviceId,accountId,mode:'opencodex',createdAt:new Date(this.service.clock()).toISOString(),disabledAt:null};
    if(!withinTransaction)this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare('INSERT INTO hub_profile_bindings(id,account_id,device_id,created_at) VALUES(?,?,?,?)').run(binding.id,accountId,deviceId,binding.createdAt);
      // Empty applied Native configuration suppresses legacy default-home fallback.
      this.service.publishDeviceConfiguration(deviceId);
      if(!withinTransaction)this.db.exec('COMMIT');return binding;
    }catch(error){if(!withinTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  stop(deviceId,bindingId){
    if(!this.db.prepare('SELECT 1 FROM hub_profile_bindings WHERE id=? AND device_id=?').get(bindingId,deviceId))this.fail(404,'binding_not_found');
    this.db.prepare("UPDATE hub_profile_bindings SET disabled_at=coalesce(disabled_at,?),state='stopped' WHERE id=?").run(new Date(this.service.clock()).toISOString(),bindingId);return{stopped:true};
  }
  desired(device){return{schemaVersion:1,profiles:this.db.prepare(`SELECT b.id bindingId,b.account_id accountId,a.name FROM hub_profile_bindings b JOIN accounts a ON a.id=b.account_id
    WHERE b.device_id=? AND b.disabled_at IS NULL AND a.archived_at IS NULL ORDER BY b.created_at,b.id`).all(device.id)};}
  deviceProfiles(deviceId){return this.db.prepare(`SELECT b.id,b.account_id accountId,b.device_id deviceId,b.disabled_at disabledAt,a.name,b.state,d.opencodex_supported supported
    FROM hub_profile_bindings b JOIN accounts a ON a.id=b.account_id JOIN devices d ON d.id=b.device_id WHERE b.device_id=? AND a.archived_at IS NULL ORDER BY b.created_at`).all(deviceId)
    .map(row=>({...row,mode:'opencodex',trackingState:row.disabledAt?'stopped':!row.supported?'waiting_for_compatible_agent':row.state}));}
  report(device,body){
    try{exactHub(body,['bindingId','state','usage','quota']);if(!['tracking','unavailable'].includes(body.state)||!Array.isArray(body.usage)||body.usage.length!==4)throw Error();
      body.usage.forEach(validateHubUsage);validateHubQuota(body.quota);
      if(new Set(body.usage.map(u=>u.range)).size!==4)throw Error();
      for(const report of [...body.usage,body.quota])if(Date.parse(report.observedAt)>this.service.clock()+300000)throw Error();
      if(typeof body.bindingId!=='string'||body.bindingId.length>128)throw Error();
    }catch{this.fail(400,'invalid_hub_report');}
    if(!this.desired(device).profiles.some(p=>p.bindingId===body.bindingId))this.fail(403,'hub_not_bound');
    const receivedAt=new Date(this.service.clock()).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try{for(const report of body.usage)this.store('hub_usage_current',body.bindingId,report,receivedAt,report.range);
      this.store('hub_quota_current',body.bindingId,body.quota,receivedAt);
      this.db.prepare('UPDATE hub_profile_bindings SET state=? WHERE id=?').run(body.state,body.bindingId);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return{accepted:true};
  }
  store(table,bindingId,report,receivedAt,range){
    const row=this.db.prepare(`SELECT * FROM ${table} WHERE binding_id=?${range?' AND range=?':''}`).get(bindingId,...(range?[range]:[]));
    // Duplicate/older snapshots cannot change values or renew freshness.
    if(row?.observed_at&&report.status==='available'&&report.observedAt<=row.observed_at){
      // A successful reread of the same cached observation can recover a
      // transient read failure, but must not renew the observation's freshness.
      if(report.observedAt===row.observed_at&&JSON.stringify(report)===row.snapshot_json)
        this.db.prepare(`UPDATE ${table} SET status='available' WHERE binding_id=?${range?' AND range=?':''}`).run(bindingId,...(range?[range]:[]));
      return;
    }
    const observedAt=report.status==='available'?report.observedAt:row?.observed_at??null;
    const json=report.status==='available'?JSON.stringify(report):row?.snapshot_json??null;
    if(range)this.db.prepare('INSERT OR REPLACE INTO hub_usage_current(binding_id,range,observed_at,received_at,status,snapshot_json) VALUES(?,?,?,?,?,?)').run(bindingId,range,observedAt,receivedAt,report.status,json);
    else this.db.prepare('INSERT OR REPLACE INTO hub_quota_current(binding_id,observed_at,received_at,status,snapshot_json) VALUES(?,?,?,?,?)').run(bindingId,observedAt,receivedAt,report.status,json);
  }
  account(accountId){
    const binding=this.db.prepare(`SELECT b.*,d.removed_at,d.disabled_at device_disabled_at FROM hub_profile_bindings b JOIN devices d ON d.id=b.device_id
      WHERE b.account_id=? ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1`).get(accountId);
    const active=binding&&!binding.disabled_at&&!binding.removed_at&&!binding.device_disabled_at;
    const view=row=>row?{status:!active?'stopped':row.status!=='available'?row.status:!row.observed_at||this.service.clock()-Date.parse(row.observed_at)>300000?'stale':'available',lastKnownGood:row.snapshot_json?JSON.parse(row.snapshot_json):null,receivedAt:row.received_at}:{status:'unavailable',lastKnownGood:null,receivedAt:null};
    return{measurementSource:'opencodex_proxy',meaning:'OpenCodex proxy/ledger-observed usage',deviceAttribution:false,
      state:!binding?'not_connected':!active?'stopped':binding.state,reporterDeviceId:binding?.device_id??null,
      ranges:Object.fromEntries(HUB_RANGES.map(range=>[range,view(binding?this.db.prepare('SELECT * FROM hub_usage_current WHERE binding_id=? AND range=?').get(binding.id,range):null)])),
      quota:view(binding?this.db.prepare('SELECT * FROM hub_quota_current WHERE binding_id=?').get(binding.id):null)};
  }
}
