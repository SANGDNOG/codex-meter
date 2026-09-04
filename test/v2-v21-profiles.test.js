import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { openAgentDatabase } from '../v2/agent/database.js';
import { openServerDatabase } from '../v2/server/database.js';
import { AgentCollector } from '../v2/agent/collector.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
import { enroll, initializeManagedHome, profileLauncher, saveConfig, validateConfig } from '../v2/agent/config.js';
import { runAgentCli } from '../v2/agent/cli.js';
import { applyDesiredConfiguration } from '../v2/agent/assignments.js';
import { MeterService, ServiceError } from '../v2/server/service.js';
import { createV2Server } from '../v2/server/http.js';
import { parseAgentCapabilityHeader, parseServerCapabilities } from '../v2/shared/capabilities.js';

const exec = promisify(execFile);

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const CAPABILITY_HEADER = 'agentConfigurationSchema=1;declarativeProfiles=1;actualState=1';
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

test('V2.1 temporal bindings preserve legacy history and enforce declarative half-open intervals',()=>fixture(async({service,addDevice,advance})=>{
  const legacy=service.createAccount({name:'Legacy'}),declarative=service.createAccount({name:'Declarative'}),unrelated=service.createAccount({name:'Unrelated'}),legacyDevice=addDevice('legacy-device'),device=addDevice('declarative-device');
  service.bindAccount(legacyDevice.id,{accountId:legacy.id,codexHomeKey:'legacy-home'});const binding=service.bindAccount(device.id,{accountId:declarative.id,mode:'default'});
  const send=(target,account,eventId,occurredAt)=>service.sync(target,body([{...event(eventId,1,account.id),occurredAt}]),target===device?{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true}:undefined);
  assert.equal(send(legacyDevice,legacy,'legacy-old','2026-09-01T11:59:59.999Z').acceptedEventIds.length,1);
  assert.deepEqual(send(device,declarative,'before-created','2026-09-01T11:59:59.999Z').rejectedEvents,[{eventId:'before-created',reason:'account_not_bound'}]);
  assert.equal(send(device,declarative,'at-created','2026-09-01T12:00:00.000Z').acceptedEventIds.length,1);
  advance(1_000);service.disableBinding(device.id,binding.id);
  assert.equal(send(device,declarative,'delayed-before-disable','2026-09-01T12:00:00.999Z').acceptedEventIds.length,1);
  assert.deepEqual(send(device,declarative,'at-disable','2026-09-01T12:00:01.000Z').rejectedEvents,[{eventId:'at-disable',reason:'account_not_bound'}]);
  assert.deepEqual(send(device,declarative,'after-disable','2026-09-01T12:00:01.001Z').rejectedEvents,[{eventId:'after-disable',reason:'account_not_bound'}]);
  assert.deepEqual(send(device,unrelated,'unrelated','2026-09-01T12:00:00.500Z').rejectedEvents,[{eventId:'unrelated',reason:'account_not_bound'}]);
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

test('V2.1 quota history composite cursor returns every same-timestamp observation exactly once',()=>fixture(async({database,service,addDevice})=>{
  const account=service.createAccount({name:'Paged'}),other=service.createAccount({name:'Other'}),device=addDevice('paged-device');
  service.bindAccount(device.id,{accountId:account.id,codexHomeKey:'paged'});service.bindAccount(device.id,{accountId:other.id,codexHomeKey:'other'});
  for(let index=0;index<7;index+=1)service.sync(device,body([],[available(account.id,index+1)]));
  service.sync(device,body([],[available(other.id,99)]));
  const expected=database.prepare('SELECT DISTINCT observation_id FROM account_quota_snapshots WHERE account_id=? ORDER BY observation_id DESC').all(account.id).map(row=>row.observation_id);
  const actual=[];let before=null,pages=0;
  do{const page=service.accountQuotaHistory(account.id,{limit:2,before});pages+=1;actual.push(...page.observations.map(row=>row.observationId));before=page.nextCursor;}while(before!==null);
  assert.ok(pages>3);assert.deepEqual(actual,expected);assert.equal(new Set(actual).size,expected.length);
  assert.equal(service.accountQuotaHistory(other.id,{limit:2}).observations.length,1);
  for(const invalid of ['', '***', Buffer.from('bad').toString('base64url'), Buffer.from('0\u0000x').toString('base64url'), Buffer.from('2026-09-01T12:00:00.000Z\u0000bad/id').toString('base64url')])
    assert.throws(()=>service.accountQuotaHistory(account.id,{limit:2,before:invalid}),error=>error instanceof ServiceError&&['invalid_cursor','invalid_field'].includes(error.code));
}));

test('V2.1 authenticated account quota history API is bounded',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-history-')),database=openServerDatabase(path.join(root,'server.db'));const server=createV2Server({database,adminPassword:'long enough test password',clock:()=>NOW});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{const account=server.service.createAccount({name:'History'});const login=await fetch(`${base}/api/v1/auth/login`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'long enough test password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(`${base}/api/v1/accounts/${account.id}/quota/history?limit=1`,{headers:{origin:base,cookie}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{observations:[],nextCursor:null});
    const invalid=await fetch(`${base}/api/v1/accounts/${account.id}/quota/history?limit=501`,{headers:{origin:base,cookie}});assert.equal(invalid.status,400);
    const invalidCursor=await fetch(`${base}/api/v1/accounts/${account.id}/quota/history?before=not-a-cursor`,{headers:{origin:base,cookie}});assert.equal(invalidCursor.status,400);
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

test('V2.1 managed home rejects root and marker symlinks while accepting owned real directories',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-symlink-'));
  try{
    const target=path.join(root,'target');await initializeManagedHome(target,'target-account');
    const linked=path.join(root,'linked');await symlink(target,linked,'dir');await assert.rejects(initializeManagedHome(linked,'target-account'),/real directory/);
    const markerHome=path.join(root,'marker-home');await mkdir(markerHome);const external=path.join(root,'marker.json');await writeFile(external,JSON.stringify({version:1,accountId:'marker-account'}));await symlink(external,path.join(markerHome,'.codex-meter-profile.json'));await assert.rejects(initializeManagedHome(markerHome,'marker-account'),/marker.*symbolic link/);
    const markerDirectoryHome=path.join(root,'marker-directory');await mkdir(path.join(markerDirectoryHome,'.codex-meter-profile.json'),{recursive:true});await assert.rejects(initializeManagedHome(markerDirectoryHome,'marker-directory-account'),/marker must be a regular file/);
    const configDirectoryHome=path.join(root,'config-directory');await mkdir(path.join(configDirectoryHome,'config.toml'),{recursive:true});await assert.rejects(initializeManagedHome(configDirectoryHome,'config-directory-account'),/config.toml must be a regular file/);
    const unrelated=path.join(root,'unrelated');await mkdir(unrelated);await writeFile(path.join(unrelated,'config.toml'),'theme = "dark"\n');await initializeManagedHome(unrelated,'new-owner');assert.equal((await lstat(unrelated)).isDirectory(),true);
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
    const cases=[
      ['bare','cli_auth_credentials_store = "file"\n',true],
      ['quoted','"cli_auth_credentials_store" = "file"\n',true],
      ['escaped','"cli_auth_credent\\u0069als_store" = "file"\n',true],
      ['conflict','cli_auth_credentials_store = "keyring"\n',false],
      ['escaped-conflict','"cli_auth_credent\\u0069als_store" = "keyring"\n',false],
      ['malformed','"cli_auth_credentials_store = "file"\n',false],
      ['duplicate','cli_auth_credentials_store = "file"\n"cli_auth_credent\\u0069als_store" = "file"\n',false]
    ];
    for(const [label,toml,allowed] of cases){const directory=path.join(root,label);await mkdir(directory);await writeFile(path.join(directory,'config.toml'),toml);if(allowed){await initializeManagedHome(directory,`${label}-profile`);assert.equal(await readFile(path.join(directory,'config.toml'),'utf8'),toml);}else await assert.rejects(initializeManagedHome(directory,`${label}-profile`),/conflicting|safely parse/);}
    const multiline=path.join(root,'multiline');await mkdir(multiline);await writeFile(path.join(multiline,'config.toml'),'note = """safe to parse"""\n');await initializeManagedHome(multiline,'multiline-profile');assert.match(await readFile(path.join(multiline,'config.toml'),'utf8'),/^cli_auth_credentials_store/);
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

test('V2.1 PowerShell launcher restores CODEX_HOME presence and value in finally',()=>{
  const launcher=profileLauncher({codexHome:"./Profiles/O'Brien",codexExecutable:"/Program Files/O'Brien/codex.exe"},'win32');
  assert.match(launcher,/\$hadCodexHome = Test-Path Env:CODEX_HOME/);assert.match(launcher,/\$previousCodexHome = \$env:CODEX_HOME/);
  assert.match(launcher,/try \{/);assert.match(launcher,/finally \{/);assert.match(launcher,/if \(\$hadCodexHome\) \{ \$env:CODEX_HOME = \$previousCodexHome \} else \{ Remove-Item Env:CODEX_HOME/);
  assert.match(launcher,/O''Brien/);assert.match(launcher,/@args/);assert.match(launcher,/\$global:LASTEXITCODE = \$null/);assert.match(launcher,/\$nativeExitCode = \$LASTEXITCODE/);assert.match(launcher,/\$codexExitCode = \$nativeExitCode/);assert.match(launcher,/exit \$codexExitCode/);
});

test('V2.1 payload/schema sources never identify provider accounts or access auth.json',async()=>{
  for(const file of ['v2/agent/app-server.js','v2/agent/collector.js','v2/agent/sync.js','v2/server/service.js']){const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');assert.doesNotMatch(source,/readFile\([^)]*auth\.json|accessToken|providerAccountId|providerEmail/i);}
});

test('V2.1 new Agent uses a header capability while preserving the legacy request shape until Server confirmation',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-protocol-')),database=openAgentDatabase(path.join(root,'agent.db')),requests=[];
  const config={serverUrl:'https://old-meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),maxBatchSize:100};
  const response={acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[],serverTime:'2026-09-01T12:00:00.000Z',agentConfiguration:{syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100},isQuotaReporter:false};
  const client=new AgentSyncClient(database,config,{clock:()=>NOW,fetchImpl:async(_url,options)=>{requests.push({headers:options.headers,body:JSON.parse(options.body)});return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});}});
  try{
    const now=new Date(NOW).toISOString();database.prepare(`INSERT INTO profile_assignments(binding_id,account_id,name,mode,origin,local_home,active,desired_revision,applied_revision,state,created_at,updated_at)
      VALUES('legacy-a','account-a','A','preserve','imported',?,1,0,0,'tracking',?,?)`).run(path.join(root,'legacy'),now,now);
    await client.sync({heartbeat:true});await client.sync({heartbeat:true});
    assert.equal(requests.length,2);assert.equal(requests[0].headers['x-codex-meter-capabilities'],CAPABILITY_HEADER);
    for(const request of requests)assert.deepEqual(Object.keys(request.body).sort(),['agentVersion','codexVersion','events','health'].sort());
    assert.equal(database.prepare('SELECT COUNT(*) count FROM profile_assignments WHERE active=1').get().count,1);
  }finally{database.close();await rm(root,{recursive:true,force:true});}
});

test('V2.1 old to new negotiation sends actual state only after explicit New Server capability confirmation',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-negotiation-')),database=openAgentDatabase(path.join(root,'agent.db')),requests=[];
  const desired={schemaVersion:1,revision:0,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles:[]};
  const base={acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[],serverTime:'2026-09-01T12:00:00.000Z',isQuotaReporter:false};
  const responses=[{...base,agentConfiguration:{syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100}},
    {...base,agentConfiguration:desired,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true}},
    {...base,agentConfiguration:desired,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true}}];
  const client=new AgentSyncClient(database,{serverUrl:'https://new-meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),maxBatchSize:100},
    {clock:()=>NOW,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify(responses.shift()),{status:200,headers:{'content-type':'application/json'}});}});
  try{
    assert.equal((await client.sync({heartbeat:true})).configuration,null);assert.equal((await client.sync({heartbeat:true})).configuration.revision,0);await client.sync({heartbeat:true});
    assert.equal('configurationState' in requests[0],false);assert.equal('configurationState' in requests[1],false);assert.deepEqual(requests[2].configurationState,{desiredRevision:0,appliedRevision:0,status:'unknown',errorKind:null,profiles:[]});
  }finally{database.close();await rm(root,{recursive:true,force:true});}
});

test('V2.1 Server capability gate keeps old Agents on legacy configuration and returns explicit metadata to new Agents',()=>fixture(async({service,addDevice})=>{
  const account=service.createAccount({name:'Personal'}),device=addDevice('protocol-device');service.bindAccount(device.id,{accountId:account.id,mode:'default'});
  const legacy=service.sync(device,body());assert.deepEqual(Object.keys(legacy.agentConfiguration).sort(),['heartbeatIntervalSeconds','maxBatchSize','syncIntervalSeconds'].sort());assert.equal('serverCapabilities' in legacy,false);
  const capable=service.sync(device,body(),{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true});
  assert.equal(capable.agentConfiguration.schemaVersion,1);assert.equal(capable.agentConfiguration.profiles.length,1);
  assert.deepEqual(capable.serverCapabilities,{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true});
}));

test('V2.1 capability grammar is strict and carries no remote execution data',()=>{
  assert.deepEqual(parseAgentCapabilityHeader(CAPABILITY_HEADER),{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true});
  for(const value of ['',`${CAPABILITY_HEADER};path=1`,`${CAPABILITY_HEADER};actualState=1`,'agentConfigurationSchema=1;declarativeProfiles=/tmp/x;actualState=1',
    'agentConfigurationSchema=1;declarativeProfiles=1;actualState=$(id)','agentConfigurationSchema=1;declarativeProfiles=1;environment=1',
    'agentConfigurationSchema=2;declarativeProfiles=1;actualState=1','agentConfigurationSchema=1;declarativeProfiles=1;actualState=0'])assert.equal(parseAgentCapabilityHeader(value),null);
  assert.equal(parseAgentCapabilityHeader(undefined),undefined);
  assert.deepEqual(parseServerCapabilities({agentConfigurationSchema:1,declarativeProfiles:true,actualState:true}),{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true});
  assert.equal(parseServerCapabilities({agentConfigurationSchema:1,declarativeProfiles:true,actualState:true,path:'/tmp/private'}),null);
  assert.equal(parseServerCapabilities(undefined),undefined);
});

test('V2.1 enrollment activates declarative configuration only with valid Server capabilities',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-enrollment-capability-')),originalFetch=globalThis.fetch;
  const desired={schemaVersion:1,revision:1,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles:[{bindingId:'binding-a',accountId:'account-a',name:'A',mode:'default'}]};
  const base={deviceId:'device',deviceSecret:'x'.repeat(32),serverUrl:'https://meter.example',agentConfiguration:desired};let response={...base};
  globalThis.fetch=async()=>new Response(JSON.stringify(response),{status:201,headers:{'content-type':'application/json'}});
  try{
    const options={serverUrl:'https://meter.example',token:'enrollment-token',codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db')};
    const legacy=await enroll({...options,configPath:path.join(root,'legacy.json')});assert.equal(legacy.desiredConfiguration,null);
    response={...base,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true,path:'/bad'}};
    const malformedPath=path.join(root,'malformed.json');await assert.rejects(enroll({...options,configPath:malformedPath}),/invalid Server capabilities/);await assert.rejects(stat(malformedPath),error=>error.code==='ENOENT');
    response={...base,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true}};
    const negotiated=await enroll({...options,configPath:path.join(root,'negotiated.json')});assert.equal(negotiated.desiredConfiguration.revision,1);
  }finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});

test('V2.1 malformed or unconfirmed Server capabilities cannot activate declarative configuration',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-unconfirmed-')),database=openAgentDatabase(path.join(root,'agent.db'));
  const desired={schemaVersion:1,revision:99,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles:[{bindingId:'b',accountId:'a',name:'A',mode:'isolated'}]};
  const responses=[{agentConfiguration:desired},{agentConfiguration:desired,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true,path:'/tmp/injected'}}];
  const client=new AgentSyncClient(database,{serverUrl:'https://old.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),maxBatchSize:100},
    {clock:()=>NOW,fetchImpl:async()=>new Response(JSON.stringify({acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[],serverTime:new Date(NOW).toISOString(),isQuotaReporter:false,...responses.shift()}),{status:200,headers:{'content-type':'application/json'}})});
  try{assert.equal((await client.sync({heartbeat:true})).configuration,null);await assert.rejects(client.sync({heartbeat:true}),/invalid Server capabilities/);assert.equal(database.prepare("SELECT value FROM agent_state WHERE key='remote_declarative_supported'").get()?.value,'false');}
  finally{database.close();await rm(root,{recursive:true,force:true});}
});

test('V2.1 confirmed New Server downgrade preserves local state, stops actual-state reporting, and recovers after malformed capability',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-v21-downgrade-')),database=openAgentDatabase(path.join(root,'agent.db')),requests=[];
  const declaration={schemaVersion:1,revision:1,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles:[{bindingId:'binding-a',accountId:'account-a',name:'A',mode:'default'}]};
  const base={acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[],serverTime:new Date(NOW).toISOString(),isQuotaReporter:false};
  const responses=[
    {...base,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true},agentConfiguration:declaration},
    {...base,agentConfiguration:{syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100}},
    {...base,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true,path:'/bad'},agentConfiguration:{...declaration,revision:2,profiles:[]}},
    {...base,serverCapabilities:{agentConfigurationSchema:1,declarativeProfiles:true,actualState:true},agentConfiguration:{...declaration,revision:2}}
  ];
  const client=new AgentSyncClient(database,{serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),maxBatchSize:100},
    {clock:()=>NOW,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify(responses.shift()),{status:200,headers:{'content-type':'application/json'}});}});
  try{
    let result=await client.sync({heartbeat:true});assert.equal(result.configuration.revision,1);await applyDesiredConfiguration(database,{codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:'codex'},result.configuration,{clock:()=>NOW,baseline:async()=>{}});
    database.prepare("INSERT INTO usage_outbox(event_id,account_id,occurred_at,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,created_at) VALUES('pending','account-a','t',1,0,NULL,0,0,1,'t')").run();
    result=await client.sync({heartbeat:true});assert.equal(result.configuration,null);assert.equal(requests[1].configurationState.appliedRevision,1);assert.equal(database.prepare("SELECT value FROM agent_state WHERE key='remote_actual_state_supported'").get().value,'false');
    await assert.rejects(client.sync({heartbeat:true}),/invalid Server capabilities/);assert.equal(database.prepare('SELECT COUNT(*) count FROM profile_assignments WHERE active=1').get().count,1);assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,1);
    result=await client.sync({heartbeat:true});assert.equal('configurationState' in requests[3],false);assert.equal(result.configuration.revision,2);assert.equal(database.prepare('SELECT COUNT(*) count FROM profile_assignments WHERE active=1').get().count,1);
  }finally{database.close();await rm(root,{recursive:true,force:true});}
});
