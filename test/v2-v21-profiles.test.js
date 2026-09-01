import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { openAgentDatabase } from '../v2/agent/database.js';
import { openServerDatabase } from '../v2/server/database.js';
import { AgentCollector } from '../v2/agent/collector.js';
import { initializeManagedHome, profileLauncher, saveConfig, validateConfig } from '../v2/agent/config.js';
import { runAgentCli } from '../v2/agent/cli.js';
import { MeterService, ServiceError } from '../v2/server/service.js';
import { createV2Server } from '../v2/server/http.js';

const exec = promisify(execFile);

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const META = (id) => `${JSON.stringify({type:'session_meta',payload:{id,model:'gpt-5'}})}\n`;
const USAGE = (tokens, minute=0) => `${JSON.stringify({timestamp:`2026-09-01T12:${String(minute).padStart(2,'0')}:00Z`,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:tokens,input_tokens:tokens,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}})}\n`;
function event(eventId,totalTokens,accountId){return{eventId,accountId,occurredAt:'2026-09-01T12:00:00.000Z',inputTokens:String(totalTokens),cachedInputTokens:'0',cacheWriteInputTokens:null,outputTokens:'0',reasoningOutputTokens:'0',totalTokens:String(totalTokens),model:'gpt-5',reasoningEffort:null};}
function body(events=[],quotaReports){return{agentVersion:'2.1.0-dev',codexVersion:null,events,health:{status:'healthy'},...(quotaReports?{quotaReports}:{})};}
function available(accountId,percent){return{accountId,observedAt:'2026-09-01T12:00:00.000Z',status:'available',planType:null,windows:[{limitId:'codex',durationMinutes:300,usedPercent:percent,resetsAt:null,slot:'primary'}]};}

async function fixture(callback){
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-'));const database=openServerDatabase(path.join(root,'server.db'));let now=NOW;
  try{
    const service=new MeterService(database,{adminPassword:'long enough test password',clock:()=>now,quotaStaleMs:60_000});
    const addDevice=(id,groupId=null)=>{database.prepare('INSERT INTO devices(id,name,credential_hash,current_group_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,id,'hash',groupId,new Date(now).toISOString(),new Date(now).toISOString());return database.prepare('SELECT * FROM devices WHERE id=?').get(id);};
    await callback({root,database,service,addDevice,advance(ms){now+=ms;}});
  }finally{database.close();await rm(root,{recursive:true,force:true});}
}

test('V2.1 account bindings authorize attribution, aggregate across devices, and preserve legacy/device/group totals',()=>fixture(async({database,service,addDevice})=>{
  database.prepare("INSERT INTO groups(id,name,created_at,updated_at) VALUES('g','Group','t','t')").run();
  const a=service.createAccount({name:'Profile A',reference:true}),b=service.createAccount({name:'Profile B'}),d1=addDevice('d1','g'),d2=addDevice('d2','g');
  database.prepare("INSERT INTO device_group_memberships(id,device_id,group_id,valid_from) VALUES('m1','d1','g','2026-09-01T00:00:00.000Z'),('m2','d2','g','2026-09-01T00:00:00.000Z')").run();
  service.bindAccount(d1.id,{accountId:a.id,codexHomeKey:'home-a'});service.bindAccount(d2.id,{accountId:a.id,codexHomeKey:'home-a'});service.bindAccount(d1.id,{accountId:b.id,codexHomeKey:'home-b'});
  assert.deepEqual(service.sync(d2,body([event('inject',3,b.id)])).rejectedEvents,[{eventId:'inject',reason:'account_not_bound'}]);
  service.sync(d1,body([event('a1',10,a.id),event('b1',20,b.id),{...event('legacy',5,a.id),accountId:undefined}]));
  service.sync(d2,body([event('a2',7,a.id)]));
  assert.equal(service.accountDetail(a.id).measured.totalTokens,'17');assert.equal(service.accountDetail(b.id).measured.totalTokens,'20');
  assert.equal(service.usage('all').measured.totalTokens,'42');assert.equal(service.usage('all',{groupId:'g'}).measured.totalTokens,'42');assert.equal(service.usage('all',{accountId:null}).measured.totalTokens,'5');
  assert.deepEqual(service.accountDetail(a.id).devices.map(x=>x.measured.totalTokens).sort(),['10','7']);
  assert.equal(database.prepare('SELECT account_id FROM usage_events WHERE event_id=?').get('legacy').account_id,null);
  const binding=service.deviceDetail(d1.id).profiles.find(x=>x.accountId===b.id);service.disableBinding(d1.id,binding.id);
  assert.deepEqual(service.sync(d1,body([event('disabled',1,b.id)])).rejectedEvents,[{eventId:'disabled',reason:'account_not_bound'}]);
  service.updateAccount(a.id,{archived:true});assert.deepEqual(service.sync(d2,body([event('archived',1,a.id)])).rejectedEvents,[{eventId:'archived',reason:'account_not_bound'}]);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM usage_events WHERE event_id IN ('inject','disabled','archived')").get().count,0);
}));

test('V2.1 profile quota is isolated by account and stale independently',()=>fixture(async({service,addDevice,advance})=>{
  const a=service.createAccount({name:'A'}),b=service.createAccount({name:'B'}),device=addDevice('device');service.bindAccount(device.id,{accountId:a.id,codexHomeKey:'a'});service.bindAccount(device.id,{accountId:b.id,codexHomeKey:'b'});
  service.sync(device,body([],[available(a.id,11),available(b.id,77)]));assert.equal(service.accountQuota(a.id).windows[0].usedPercent,11);assert.equal(service.accountQuota(b.id).windows[0].usedPercent,77);
  advance(60_001);assert.equal(service.accountQuota(a.id).status,'stale');
  service.sync(device,body([],[{...available(b.id,55),observedAt:new Date(NOW+60_001).toISOString()}]));assert.equal(service.accountQuota(a.id).status,'stale');assert.equal(service.accountQuota(b.id).status,'available');
}));

test('V2.1 profile quota rejects duplicates/future time, ignores late current regression, and exposes bounded history',()=>fixture(async({database,service,addDevice,advance})=>{
  const account=service.createAccount({name:'Quota Account'}),device=addDevice('quota-device');service.bindAccount(device.id,{accountId:account.id,codexHomeKey:'quota-home'});
  assert.throws(()=>service.sync(device,body([],[available(account.id,1),available(account.id,2)])),error=>error instanceof ServiceError&&error.code==='duplicate_account_quota');
  assert.throws(()=>service.sync(device,body([],[{...available(account.id,1),observedAt:new Date(NOW+300_001).toISOString()}])),error=>error instanceof ServiceError&&error.code==='invalid_quota_time');
  service.sync(device,body([],[available(account.id,10)]));advance(10_000);service.sync(device,body([],[{...available(account.id,20),observedAt:new Date(NOW+10_000).toISOString()}]));
  service.sync(device,body([],[available(account.id,5)]));assert.equal(service.accountQuota(account.id).windows[0].usedPercent,20);
  const history=service.accountQuotaHistory(account.id,{limit:2});assert.equal(history.observations.length,2);assert.equal(database.prepare('SELECT COUNT(DISTINCT observation_id) count FROM account_quota_snapshots WHERE account_id=?').get(account.id).count,3);
  assert.throws(()=>service.accountQuotaHistory(account.id,{limit:501}),/invalid_limit/);
}));

test('V2.1 authenticated account quota history API is bounded',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-history-')),database=openServerDatabase(path.join(root,'server.db'));const server=createV2Server({database,adminPassword:'long enough test password',clock:()=>NOW});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{const account=server.service.createAccount({name:'History'});const login=await fetch(`${base}/api/v1/auth/login`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'long enough test password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(`${base}/api/v1/accounts/${account.id}/quota/history?limit=1`,{headers:{origin:base,cookie}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{observations:[]});
    const invalid=await fetch(`${base}/api/v1/accounts/${account.id}/quota/history?limit=501`,{headers:{origin:base,cookie}});assert.equal(invalid.status,400);
  }finally{await new Promise(resolve=>server.close(resolve));database.close();await rm(root,{recursive:true,force:true});}
});

test('V2.1 independent profile roots baseline and attribute simultaneous appends with stable IDs',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-agent-'));const db=openAgentDatabase(path.join(root,'agent.db'));
  try{
    const homes=[path.join(root,'a'),path.join(root,'b')],ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
    const files=[];for(let i=0;i<2;i++){const dir=path.join(homes[i],'sessions','2026','09','01');await mkdir(dir,{recursive:true});files[i]=path.join(dir,`rollout-2026-09-01T12-00-00-${ids[i]}.jsonl`);await writeFile(files[i],META(ids[i])+USAGE(99));}
    const collectors=homes.map((home,i)=>new AgentCollector(db,{home,accountId:`account-${i}`}));await Promise.all(collectors.map(c=>c.reconcile()));
    await Promise.all(files.map((file,i)=>appendFile(file,USAGE(i+3,i+1))));await Promise.all(collectors.map(c=>c.reconcile()));
    const rows=db.prepare('SELECT event_id,account_id,total_tokens FROM usage_outbox ORDER BY account_id').all();assert.deepEqual(rows.map(r=>[r.account_id,r.total_tokens]),[['account-0',3],['account-1',4]]);const idsBefore=rows.map(r=>r.event_id);await Promise.all(collectors.map(c=>c.reconcile()));assert.deepEqual(db.prepare('SELECT event_id FROM usage_outbox ORDER BY account_id').all().map(r=>r.event_id),idsBefore);
  }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('V2.1 profile partial retry, archive move, outbox restart, and server dedupe preserve attribution',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-regression-'));const dbPath=path.join(root,'agent.db'),home=path.join(root,'profile'),id='33333333-3333-4333-8333-333333333333';let db=openAgentDatabase(dbPath);
  try{const sessionDir=path.join(home,'sessions','2026','09','01');await mkdir(sessionDir,{recursive:true});let file=path.join(sessionDir,`rollout-2026-09-01T12-00-00-${id}.jsonl`);await writeFile(file,META(id)+USAGE(99));let collector=new AgentCollector(db,{home,accountId:'account-a'});await collector.reconcile();
    const partial=USAGE(5,1);await appendFile(file,partial.slice(0,-1));await collector.reconcile();assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,0);await appendFile(file,'\n');await collector.reconcile();assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,1);
    const archiveDir=path.join(home,'archived_sessions','2026','09','01');await mkdir(archiveDir,{recursive:true});const archived=path.join(archiveDir,path.basename(file));await rename(file,archived);file=archived;await appendFile(file,USAGE(7,2));await collector.reconcile();assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,2);
    const idsBefore=db.prepare('SELECT event_id FROM usage_outbox ORDER BY sequence').all().map(row=>row.event_id);db.close();db=openAgentDatabase(dbPath);collector=new AgentCollector(db,{home,accountId:'account-a'});await collector.reconcile();assert.deepEqual(db.prepare('SELECT event_id FROM usage_outbox ORDER BY sequence').all().map(row=>row.event_id),idsBefore);
    await fixture(async({service,addDevice})=>{const account=service.createAccount({name:'Dedupe'}),device=addDevice('dedupe-device');service.bindAccount(device.id,{accountId:account.id,codexHomeKey:'dedupe-home'});const events=idsBefore.map((eventId,index)=>event(eventId,index?7:5,account.id));const first=service.sync(device,body(events)),second=service.sync(device,body(events));assert.equal(first.acceptedEventIds.length,2);assert.deepEqual(second.duplicateEventIds,idsBefore);});
  }finally{if(db.isOpen)db.close();await rm(root,{recursive:true,force:true});}
});

test('V2.1 managed homes are private, permanently owned, conflict-safe, launcher-ready, and config rejects home reuse',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-home-'));try{const home=path.join(root,'profile');const result=await initializeManagedHome(home,'account-a');assert.equal((await stat(home)).mode&0o777,0o700);assert.equal((await stat(result.configPath)).mode&0o777,0o600);assert.equal(await readFile(result.configPath,'utf8'),'cli_auth_credentials_store = "file"\n');
    await initializeManagedHome(home,'account-a');await assert.rejects(initializeManagedHome(home,'account-b'),/different Account Profile/);
    await writeFile(result.configPath,'cli_auth_credentials_store = "keyring"\n');await assert.rejects(initializeManagedHome(home,'account-a'),/conflicting/);
    assert.match(profileLauncher({codexHome:home},'linux'),/export CODEX_HOME=/);assert.match(profileLauncher({codexHome:home},'win32'),/\$env:CODEX_HOME/);
    const base={serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32)};assert.throws(()=>validateConfig({...base,profiles:[{accountId:'a',name:'A',codexHome:home},{accountId:'b',name:'B',codexHome:home}]}),/reuse/);
    assert.throws(()=>validateConfig({...base,profiles:[{accountId:'a',name:'A',codexHome:home},{accountId:'b',name:'B',codexHome:path.join(home,'nested')}]}),/overlap/);
    assert.equal((await lstat(home)).isDirectory(),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('V2.1 profile-add initializes a dedicated home and preserves existing TOML tables',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-cli-'));
  try{
    const configPath=path.join(root,'agent.json'),home=path.join(root,'profiles','personal');
    await saveConfig(configPath,{serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),databasePath:path.join(root,'agent.db')});
    const output=[];await runAgentCli(['profile-add','--config',configPath,'--account','profile-id','--name','Personal','--codex-home',home],{stdout:{write:value=>output.push(value)},stderr:{write(){}}});
    assert.match(output.join(''),/profile added/);
    assert.equal(JSON.parse(await readFile(configPath,'utf8')).profiles[0].accountId,'profile-id');
    assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),'cli_auth_credentials_store = "file"\n');
    const other=path.join(root,'existing');await mkdir(other);await writeFile(path.join(other,'config.toml'),'[projects]\ntrust = "all"\n');
    await initializeManagedHome(other,'profile-existing');
    assert.equal(await readFile(path.join(other,'config.toml'),'utf8'),'cli_auth_credentials_store = "file"\n[projects]\ntrust = "all"\n');
    const quoted=path.join(root,'quoted');await mkdir(quoted);await writeFile(path.join(quoted,'config.toml'),'"cli_auth_credentials_store" = "keyring"\n');await assert.rejects(initializeManagedHome(quoted,'quoted-profile'),/conflicting/);
    const multiline=path.join(root,'multiline');await mkdir(multiline);await writeFile(path.join(multiline,'config.toml'),'note = """unsafe to edit"""\n');await assert.rejects(initializeManagedHome(multiline,'multiline-profile'),/multiline TOML/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('V2.1 POSIX launcher preserves literal CODEX_HOME and arguments',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-launcher-'));try{
    const bin=path.join(root,'bin'),capture=path.join(root,'capture.json'),home=path.join(root,"home $() ' quoted");await mkdir(bin);const codex=path.join(bin,'codex'),launcher=path.join(root,'codex-profile');
    await writeFile(codex,'#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE,JSON.stringify({home:process.env.CODEX_HOME,args:process.argv.slice(2)}));\n');await chmod(codex,0o700);
    await writeFile(launcher,profileLauncher({codexHome:home},'linux'));await chmod(launcher,0o700);
    await exec(launcher,['argument with spaces','$literal'],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,CAPTURE:capture}});
    assert.deepEqual(JSON.parse(await readFile(capture,'utf8')),{home:path.resolve(home),args:['argument with spaces','$literal']});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('V2.1 payload/schema sources never identify provider accounts or access auth.json',async()=>{
  for(const file of ['v2/agent/app-server.js','v2/agent/collector.js','v2/agent/sync.js','v2/server/service.js']){const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');assert.doesNotMatch(source,/readFile\([^)]*auth\.json|accessToken|providerAccountId|providerEmail/i);}
});
