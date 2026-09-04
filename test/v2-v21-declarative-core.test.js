import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAgentDatabase } from '../v2/agent/database.js';
import { AgentRuntime } from '../v2/agent/runtime.js';
import { AgentCollector } from '../v2/agent/collector.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
import { applyDesiredConfiguration, assignmentRows, configurationState, importLegacyProfiles, validateDesiredConfiguration } from '../v2/agent/assignments.js';
import { profileLauncher } from '../v2/agent/config.js';
import { openServerDatabase } from '../v2/server/database.js';
import { MeterService, ServiceError } from '../v2/server/service.js';
import { createV2Server } from '../v2/server/http.js';
import { AGENT_CAPABILITY_HEADER, AGENT_CAPABILITY_HEADER_VALUE } from '../v2/shared/capabilities.js';

const NOW=Date.parse('2026-09-01T18:20:00.000Z');
const CAPS={agentConfigurationSchema:1,declarativeProfiles:true,actualState:true};
const syncBody=(configurationStateValue)=>({agentVersion:'2.1-test',codexVersion:null,events:[],health:{status:'healthy'},...(configurationStateValue?{configurationState:configurationStateValue}:{})});
const profile=(binding,account,mode='default',state='tracking')=>({bindingId:binding,accountId:account,mode,state});
const desired=(revision,profiles)=>({schemaVersion:1,revision,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles});
const serviceError=(code)=>(error)=>error instanceof ServiceError&&error.code===code;
const META=(id)=>`${JSON.stringify({type:'session_meta',payload:{id,model:'gpt-5'}})}\n`;
const USAGE=(tokens,minute)=>`${JSON.stringify({timestamp:`2026-09-01T18:${String(minute).padStart(2,'0')}:00Z`,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:tokens,input_tokens:tokens,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}})}\n`;

async function tempDatabase(callback){const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-core-'));const database=openAgentDatabase(path.join(root,'agent.db'));try{return await callback({root,database});}finally{database.close();await rm(root,{recursive:true,force:true});}}

function addServerDevice(database,id='device'){database.prepare('INSERT INTO devices(id,name,credential_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,id,'hash',new Date(NOW).toISOString(),new Date(NOW).toISOString());return database.prepare('SELECT * FROM devices WHERE id=?').get(id);}

test('Core actual-state distinguishes profile mismatches, accepts last-known-good, and rollback creates a new revision',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-server-core-')),database=openServerDatabase(path.join(root,'server.db'));
  try{
    const service=new MeterService(database,{adminPassword:'long enough test password',clock:()=>NOW});let device=addServerDevice(database);
    const a=service.createAccount({name:'A'}),b=service.createAccount({name:'B'}),ba=service.bindAccount(device.id,{accountId:a.id,mode:'default'}),bb=service.bindAccount(device.id,{accountId:b.id,mode:'isolated'});
    device=database.prepare('SELECT * FROM devices WHERE id=?').get(device.id);
    const lkg={desiredRevision:2,appliedRevision:1,status:'apply_failed',errorKind:'profile_collision',profiles:[profile(ba.id,a.id)]};
    service.sync(device,syncBody(lkg),CAPS);
    assert.deepEqual({...database.prepare('SELECT desired_config_revision,applied_config_revision,configuration_status,configuration_error_kind FROM devices WHERE id=?').get(device.id)},
      {desired_config_revision:2,applied_config_revision:1,configuration_status:'apply_failed',configuration_error_kind:'profile_collision'});
    const attempt=(state,code)=>assert.throws(()=>service.sync(database.prepare('SELECT * FROM devices WHERE id=?').get(device.id),syncBody(state),CAPS),serviceError(code));
    attempt({...lkg,profiles:[]},'missing_configuration_profile');
    attempt({...lkg,profiles:[profile(ba.id,a.id),profile(bb.id,b.id,'isolated')]},'extra_configuration_profile');
    attempt({...lkg,profiles:[profile(ba.id,b.id)]},'wrong_configuration_account');
    attempt({...lkg,profiles:[profile(ba.id,a.id,'isolated')]},'wrong_configuration_mode');
    database.prepare('UPDATE devices SET desired_config_revision=8 WHERE id=?').run(device.id);
    attempt({desiredRevision:8,appliedRevision:7,status:'apply_failed',errorKind:'stale',profiles:[]},'stale_configuration_revision');
    database.prepare('UPDATE devices SET desired_config_revision=2 WHERE id=?').run(device.id);
    const rolled=service.rollbackConfiguration(device.id,{revision:1});assert.equal(rolled.revision,3);
    assert.deepEqual(service.desiredConfiguration(device.id).profiles.map(item=>[item.bindingId,item.accountId,item.mode]),[[ba.id,a.id,'default']]);
  }finally{database.close();await rm(root,{recursive:true,force:true});}
});

test('Core declarative schema rejects path, command, script, and environment fields',()=>{
  const clean=desired(1,[{bindingId:'b',accountId:'a',name:'A',mode:'isolated'}]);assert.deepEqual(validateDesiredConfiguration(clean).profiles[0],clean.profiles[0]);
  for(const [scope,key,value] of [['configuration','path','/private/home'],['configuration','environment',{TOKEN:'secret'}],['profile','codexHome','/private/home'],['profile','command','rm -rf /'],['profile','script','payload'],['profile','executablePath','/bin/codex']]){
    const candidate=structuredClone(clean);if(scope==='configuration')candidate[key]=value;else candidate.profiles[0][key]=value;assert.throws(()=>validateDesiredConfiguration(candidate),/invalid desired/);
  }
});

test('Core default home adoption baselines without modifying the external home or assigning it twice',()=>tempDatabase(async({root,database})=>{
  const home=path.join(root,'.codex');await mkdir(path.join(home,'sessions'),{recursive:true});await writeFile(path.join(home,'auth.json'),'opaque authentication sentinel');await writeFile(path.join(home,'config.toml'),'model = "gpt-5"\n');
  const before=await Promise.all(['auth.json','config.toml'].map(async name=>({name,...await stat(path.join(home,name))})));
  const config={codexHome:home,databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex')};let baselines=0;
  const result=await applyDesiredConfiguration(database,config,desired(1,[{bindingId:'b1',accountId:'a1',name:'Personal',mode:'default'}]),{clock:()=>NOW,baseline:async()=>{baselines+=1;}});
  assert.equal(result.applied,true);assert.equal(baselines,1);assert.deepEqual((await readdir(home)).sort(),['auth.json','config.toml','sessions']);
  const after=await Promise.all(['auth.json','config.toml'].map(async name=>({name,...await stat(path.join(home,name))})));
  assert.deepEqual(after.map(x=>[x.name,x.size,x.mtimeMs]),before.map(x=>[x.name,x.size,x.mtimeMs]));
  const rejected=await applyDesiredConfiguration(database,config,desired(2,[{bindingId:'b1',accountId:'a1',name:'Personal',mode:'default'},{bindingId:'b2',accountId:'a2',name:'Research',mode:'default'}]),{clock:()=>NOW,baseline:async()=>{}});
  assert.equal(rejected.applied,false);assert.equal(configurationState(database).appliedRevision,1);assert.deepEqual(assignmentRows(database).map(row=>row.accountId),['a1']);
}));

test('Core single legacy preserve declaration adopts only the configured Meter home',()=>tempDatabase(async({root,database})=>{
  const home=path.join(root,'.codex'),config={codexHome:home,databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex')};let baselines=0;
  const result=await applyDesiredConfiguration(database,config,desired(1,[{bindingId:'legacy-binding',accountId:'legacy-account',name:'Legacy',mode:'preserve'}]),{clock:()=>NOW,baseline:async()=>{baselines+=1;}});
  assert.equal(result.applied,true);assert.equal(baselines,1);assert.deepEqual(assignmentRows(database).map(row=>[row.accountId,row.mode,row.origin,row.localHome]),[['legacy-account','preserve','imported',home]]);
}));

test('Core managed isolated homes cannot enter the default home through a symlink',()=>tempDatabase(async({root,database})=>{
  const physicalDefault=path.join(root,'default-home'),linkedDefault=path.join(root,'linked-default');await mkdir(physicalDefault);await symlink(physicalDefault,linkedDefault);
  const config={codexHome:linkedDefault,databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex')},candidate=desired(1,[{bindingId:'isolated-binding',accountId:'isolated-account',name:'Research',mode:'isolated'}]);
  const result=await applyDesiredConfiguration(database,config,candidate,{clock:()=>NOW,isolatedRoot:()=>path.join(physicalDefault,'managed'),launcherDirectory:path.join(root,'bin'),platform:'linux'});
  assert.equal(result.applied,false);assert.equal(configurationState(database).appliedRevision,0);assert.equal(configurationState(database).errorKind,'profile_apply_failed');assert.equal(configurationState(database).errorKind.includes(root),false);await assert.rejects(stat(path.join(physicalDefault,'managed')));
}));

test('Core cx1/cx2 import is zero-touch for homes, launchers, cursors, outbox, history, and authentication environment',()=>tempDatabase(async({root,database})=>{
  const homes=[path.join(root,'Home A'),path.join(root,'Home B')],accounts=['personal','research'],launcherDirectory=path.join(root,'bin');await mkdir(launcherDirectory);
  const profiles=[];for(let index=0;index<2;index++){await mkdir(path.join(homes[index],'sessions'),{recursive:true});await writeFile(path.join(homes[index],'auth.json'),`opaque-${index}`);profiles.push({accountId:accounts[index],name:index?'Research':'Personal',codexHome:homes[index]});await writeFile(path.join(launcherDirectory,`cx${index+1}`),profileLauncher(profiles[index],'linux'));}
  database.prepare("INSERT INTO rollout_cursors(rollout_key,file_identity,byte_offset,updated_at) VALUES('cursor-a','identity',123,'t')").run();
  database.prepare(`INSERT INTO usage_outbox(event_id,account_id,occurred_at,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,created_at)
    VALUES('pending','personal','t',1,0,NULL,0,0,1,'t')`).run();
  database.prepare("INSERT INTO usage_dead_letters(event_id,account_id,reason,rejected_at) VALUES('history','research','account_not_bound','t')").run();
  const authStats=await Promise.all(homes.map(home=>stat(path.join(home,'auth.json')))),launcherStats=await Promise.all([1,2].map(i=>stat(path.join(launcherDirectory,`cx${i}`))));
  await importLegacyProfiles(database,{profiles,databasePath:path.join(root,'agent.db')},{clock:()=>NOW,launcherDirectory,platform:'linux'});
  assert.deepEqual(assignmentRows(database).map(row=>[row.accountId,row.localHome,row.launcherName,row.mode]),[['personal',homes[0],'cx1','preserve'],['research',homes[1],'cx2','preserve']]);
  assert.deepEqual({...database.prepare('SELECT rollout_key,file_identity,byte_offset FROM rollout_cursors').get()},{rollout_key:'cursor-a',file_identity:'identity',byte_offset:123});
  assert.deepEqual({...database.prepare('SELECT event_id,account_id,total_tokens FROM usage_outbox').get()},{event_id:'pending',account_id:'personal',total_tokens:1});
  assert.deepEqual({...database.prepare('SELECT event_id,account_id,reason FROM usage_dead_letters').get()},{event_id:'history',account_id:'research',reason:'account_not_bound'});
  assert.deepEqual(await Promise.all(homes.map(home=>readdir(home))),[['auth.json','sessions'],['auth.json','sessions']]);
  assert.deepEqual((await Promise.all(homes.map(home=>stat(path.join(home,'auth.json'))))).map(x=>[x.size,x.mtimeMs]),authStats.map(x=>[x.size,x.mtimeMs]));
  assert.deepEqual((await Promise.all([1,2].map(i=>stat(path.join(launcherDirectory,`cx${i}`))))).map(x=>[x.size,x.mtimeMs]),launcherStats.map(x=>[x.size,x.mtimeMs]));
  await importLegacyProfiles(database,{profiles,databasePath:path.join(root,'agent.db')},{clock:()=>NOW,launcherDirectory,platform:'linux'});assert.equal(assignmentRows(database).length,2);
}));

test('Core runtime serializes reconcile/sync/configuration races and preserves last-known-good resources',()=>tempDatabase(async({root,database})=>{
  const pending=[];database.prepare(`INSERT INTO usage_outbox(event_id,occurred_at,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,created_at)
    VALUES('pending','t',1,0,NULL,0,0,1,'t')`).run();
  database.prepare("INSERT INTO rollout_cursors(rollout_key,file_identity,byte_offset,updated_at) VALUES('stable-cursor','identity',42,'t')").run();
  let releaseReconcile;const firstGate=new Promise(resolve=>{releaseReconcile=resolve;});let first=true,reconciles=0,syncCalls=0,configureCalls=0,openWatchers=0;
  const collectorFactory=(entry)=>({home:entry.localHome,accountId:entry.accountId,async reconcile(){reconciles+=1;if(first){first=false;await firstGate;}}});
  let response=desired(1,[{bindingId:'a',accountId:'a',name:'A',mode:'default'}]),releaseSync=null,syncError=null;
  const syncClient={configureProfiles(){configureCalls+=1;},async sync(){syncCalls+=1;if(releaseSync)await new Promise(resolve=>{const prior=releaseSync;releaseSync=()=>{prior?.();releaseSync=null;resolve();};});if(syncError)throw syncError;return{configuration:response};}};
  const watchImpl=()=>{openWatchers+=1;let closed=false;return{close(){if(!closed){closed=true;openWatchers-=1;}}};};
  const config={codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex'),profiles:[],reconcileIntervalMs:999999,syncIntervalMs:999999,heartbeatIntervalMs:999999};
  const runtime=new AgentRuntime(database,config,{collectorFactory,syncClient,watchImpl,applyOptions:{clock:()=>NOW,baseline:async()=>{},isolatedRoot:(_config,binding)=>path.join(root,'profiles',binding),launcherDirectory:path.join(root,'bin'),platform:'linux'}});
  const collecting=runtime.reconcile(),syncing=runtime.sync(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(syncCalls,0);releaseReconcile();await collecting;await syncing;assert.equal(configurationState(database).appliedRevision,1);assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,1);
  const collectorCount=runtime.collectors.length;await runtime.applyConfiguration(response);assert.equal(runtime.collectors.length,collectorCount);assert.equal(configureCalls,1);
  runtime.running=true;runtime.refreshWatchers();assert.equal(openWatchers,3);
  releaseSync=()=>{};response=desired(2,[{bindingId:'a',accountId:'a',name:'A',mode:'default'},{bindingId:'b',accountId:'b',name:'B',mode:'isolated'}]);const blockedSync=runtime.sync(true);await new Promise(resolve=>setImmediate(resolve));runtime.trigger();assert.equal(reconciles,1);releaseSync();await blockedSync;await runtime.operation;
  assert.equal(runtime.collectors.length,2,JSON.stringify(configurationState(database)));assert.equal(openWatchers,6);assert.equal(reconciles,3);while(syncCalls<3)await new Promise(resolve=>setImmediate(resolve));
  response=desired(3,[{bindingId:'b',accountId:'b',name:'B',mode:'isolated'}]);syncError=new Error('offline');runtime.nextSyncAt=0;await assert.rejects(runtime.sync(true),/offline/);assert.equal(configurationState(database).appliedRevision,2);assert.equal(runtime.collectors.length,2);syncError=null;runtime.nextSyncAt=0;await runtime.sync(true);assert.deepEqual(runtime.activeAssignments().map(row=>row.accountId),['b']);assert.equal(openWatchers,3);
  response=desired(4,[{bindingId:'b',accountId:'b',name:'B',mode:'default'}]);await runtime.sync(true);assert.equal(runtime.activeAssignments()[0].mode,'default');assert.equal(openWatchers,3);
  const lkgCollectors=runtime.collectors,lkgWatchers=openWatchers,launchersBefore=(await readdir(path.join(root,'bin'))).sort();
  const collision=desired(5,[{bindingId:'b',accountId:'b',name:'B',mode:'isolated'},{bindingId:'c',accountId:'c',name:'C',mode:'isolated'}]);
  runtime.applyOptions.isolatedRoot=()=>path.join(root,'collision');const failed=await runtime.applyConfiguration(collision);assert.equal(failed.applied,false);assert.equal(configurationState(database).desiredRevision,5);assert.equal(configurationState(database).appliedRevision,4);assert.equal(configurationState(database).status,'apply_failed');assert.equal(runtime.collectors,lkgCollectors);assert.equal(openWatchers,lkgWatchers);await assert.rejects(stat(path.join(root,'collision')));assert.deepEqual((await readdir(path.join(root,'bin'))).sort(),launchersBefore);
  runtime.applyOptions.isolatedRoot=(_config,binding)=>path.join(root,'retry',binding);const retried=await runtime.applyConfiguration(collision);assert.equal(retried.applied,true);assert.equal(configurationState(database).appliedRevision,5);assert.equal(runtime.collectors.length,2);assert.equal(openWatchers,6);assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,1);assert.deepEqual({...database.prepare("SELECT file_identity,byte_offset FROM rollout_cursors WHERE rollout_key='stable-cursor'").get()},{file_identity:'identity',byte_offset:42});
  runtime.running=false;for(const watcher of runtime.watchers)watcher.close();runtime.watchers=[];assert.equal(openWatchers,0);
  const restarted=new AgentRuntime(database,config,{collectorFactory,syncClient,watchImpl,applyOptions:runtime.applyOptions});restarted.installAssignments();assert.equal(configurationState(database).appliedRevision,5);assert.deepEqual(restarted.activeAssignments().map(row=>row.accountId).sort(),['b','c']);assert.equal(restarted.collectors.length,2);
}));

test('Core confirmed Server downgrade and malformed recovery preserve last-known-good runtime resources',()=>tempDatabase(async({root,database})=>{
  const declaration=desired(1,[{bindingId:'binding-a',accountId:'account-a',name:'A',mode:'default'}]),base={acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[],serverTime:new Date(NOW).toISOString(),isQuotaReporter:false};
  const responses=[{...base,serverCapabilities:CAPS,agentConfiguration:declaration},{...base,agentConfiguration:{syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100}},
    {...base,serverCapabilities:{...CAPS,unknown:true},agentConfiguration:desired(2,[])},{...base,serverCapabilities:CAPS,agentConfiguration:{...declaration,revision:2}}],requests=[];
  const config={serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex'),maxBatchSize:100};
  const client=new AgentSyncClient(database,config,{clock:()=>NOW,quotaReporterFactory:(entry)=>({accountId:entry.accountId,async observe(){return{accountId:entry.accountId,observedAt:new Date(NOW).toISOString(),status:'unavailable',errorKind:'not_authenticated',planType:null,windows:[]};}}),fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify(responses.shift()),{status:200,headers:{'content-type':'application/json'}});}});
  let openWatchers=0;const runtime=new AgentRuntime(database,config,{syncClient:client,collectorFactory:(entry)=>({home:entry.localHome,accountId:entry.accountId,async reconcile(){return entry.accountId;}}),watchImpl:()=>{openWatchers+=1;let closed=false;return{close(){if(!closed){closed=true;openWatchers-=1;}}};},applyOptions:{clock:()=>NOW,baseline:async()=>{}}});runtime.running=true;
  await runtime.sync(true);const lkgCollectors=runtime.collectors,lkgReporters=client.profileQuotaReporters,lkgWatchers=runtime.watchers;assert.equal(configurationState(database).appliedRevision,1);assert.equal(openWatchers,3);
  database.prepare("INSERT INTO rollout_cursors(rollout_key,file_identity,byte_offset,updated_at) VALUES('stable','identity',42,'t')").run();database.prepare(`INSERT INTO usage_outbox(event_id,account_id,occurred_at,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,created_at) VALUES('pending','account-a','t',1,0,NULL,0,0,1,'t')`).run();
  const downgraded=await runtime.sync(true);assert.equal(downgraded.configuration,null);assert.equal(requests[1].configurationState.appliedRevision,1);assert.equal(configurationState(database).appliedRevision,1);assert.equal(runtime.collectors,lkgCollectors);assert.equal(client.profileQuotaReporters,lkgReporters);assert.equal(runtime.watchers,lkgWatchers);assert.equal(openWatchers,3);
  await assert.rejects(runtime.sync(true),/invalid Server capabilities/);assert.equal(runtime.collectors,lkgCollectors);assert.equal(client.profileQuotaReporters,lkgReporters);assert.equal(runtime.watchers,lkgWatchers);assert.equal(configurationState(database).desiredRevision,1);assert.deepEqual({...database.prepare("SELECT file_identity,byte_offset FROM rollout_cursors WHERE rollout_key='stable'").get()},{file_identity:'identity',byte_offset:42});assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,1);assert.deepEqual(await runtime.reconcile(),['account-a']);
  runtime.nextSyncAt=0;await runtime.sync(true);assert.equal('configurationState' in requests[3],false);assert.equal(configurationState(database).appliedRevision,2);assert.equal(runtime.collectors.length,1);assert.equal(client.profileQuotaReporters.length,1);assert.equal(openWatchers,3);runtime.running=false;for(const watcher of runtime.watchers)watcher.close();assert.equal(openWatchers,0);
}));

test('Core selective tracking ignores unrelated homes until explicit local opt-in',()=>tempDatabase(async({root,database})=>{
  const homeA=path.join(root,'Home A'),homeB=path.join(root,'Home B'),bin=path.join(root,'bin');await mkdir(bin);const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  for(const [home,id] of [[homeA,ids[0]],[homeB,ids[1]]]){const dir=path.join(home,'sessions','2026','09','01');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,`rollout-${id}.jsonl`),META(id)+USAGE(100,0));await writeFile(path.join(home,'config.toml'),`sentinel = "${id}"\n`);await writeFile(path.join(home,'auth.json'),`opaque-${id}`);}
  const a={accountId:'personal',name:'Personal',codexHome:homeA},b={accountId:'research',name:'Research',codexHome:homeB};await writeFile(path.join(bin,'cx1'),profileLauncher(a,'linux'));await writeFile(path.join(bin,'cx2'),profileLauncher(b,'linux'));
  const snapshotB=async()=>({config:await readFile(path.join(homeB,'config.toml'),'utf8'),auth:await readFile(path.join(homeB,'auth.json'),'utf8'),files:(await readdir(homeB)).sort(),configMtime:(await stat(path.join(homeB,'config.toml'))).mtimeMs,authMtime:(await stat(path.join(homeB,'auth.json'))).mtimeMs});const beforeB=await snapshotB();
  const config={profiles:[a],serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex'),maxBatchSize:100};await importLegacyProfiles(database,config,{clock:()=>NOW,launcherDirectory:bin,platform:'linux'});
  const requests=[],watched=new Map();const quotaReporterFactory=(entry)=>({accountId:entry.accountId,home:entry.localHome,async observe(){return{accountId:entry.accountId,observedAt:new Date(NOW).toISOString(),status:'unavailable',errorKind:'not_authenticated',planType:null,windows:[]};}});
  const syncClient=new AgentSyncClient(database,config,{clock:()=>NOW,quotaReporterFactory,fetchImpl:async(_url,options)=>{const request=JSON.parse(options.body);requests.push(request);return new Response(JSON.stringify({acceptedEventIds:request.events.map(event=>event.eventId),duplicateEventIds:[],rejectedEvents:[],serverTime:new Date(NOW).toISOString(),isQuotaReporter:false}),{status:200,headers:{'content-type':'application/json'}});}});
  const runtime=new AgentRuntime(database,config,{collectorFactory:(entry)=>new AgentCollector(database,{home:entry.localHome,accountId:entry.accountId}),syncClient,watchImpl:(directory)=>{watched.set(directory,(watched.get(directory)??0)+1);let closed=false;return{close(){if(closed)return;closed=true;const remaining=watched.get(directory)-1;if(remaining)watched.set(directory,remaining);else watched.delete(directory);}};}});runtime.installAssignments();runtime.refreshWatchers();
  assert.deepEqual(runtime.collectors.map(item=>item.home),[homeA]);assert.deepEqual(syncClient.profileQuotaReporters.map(item=>[item.accountId,item.home]),[['personal',homeA]]);assert.equal([...watched.keys()].some(value=>value.startsWith(homeB)),false);await runtime.collectors[0].reconcile();assert.equal(database.prepare('SELECT COUNT(*) count FROM rollout_cursors').get().count,1);
  await runtime.sync(true);assert.deepEqual(requests[0].quotaReports.map(report=>report.accountId),['personal']);for(const forbidden of ['research',homeB,'cx2'])assert.equal(JSON.stringify(requests[0]).includes(forbidden),false,forbidden);assert.deepEqual(await snapshotB(),beforeB);
  await importLegacyProfiles(database,{...config,profiles:[a,b]},{clock:()=>NOW,launcherDirectory:bin,platform:'linux'});runtime.installAssignments();runtime.refreshWatchers();assert.deepEqual(runtime.collectors.map(item=>item.home).sort(),[homeA,homeB].sort());assert.deepEqual(syncClient.profileQuotaReporters.map(item=>item.accountId).sort(),['personal','research']);assert.equal([...watched.keys()].some(value=>value.startsWith(homeB)),true);
  const research=runtime.collectors.find(item=>item.accountId==='research');await research.reconcile();await appendFile(path.join(homeB,'sessions','2026','09','01',`rollout-${ids[1]}.jsonl`),USAGE(7,2));await research.reconcile();
  assert.deepEqual(database.prepare('SELECT account_id,total_tokens FROM usage_outbox').all().map(row=>[row.account_id,row.total_tokens]),[['research',7]]);await runtime.sync(true);assert.deepEqual(requests.at(-1).quotaReports.map(report=>report.accountId).sort(),['personal','research']);assert.deepEqual(requests.at(-1).events.map(event=>[event.accountId,event.totalTokens]),[['research','7']]);assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,0);
  const afterB=await snapshotB();assert.equal(afterB.config,beforeB.config);assert.equal(afterB.auth,beforeB.auth);assert.equal(afterB.configMtime,beforeB.configMtime);assert.equal(afterB.authMtime,beforeB.authMtime);assert.deepEqual(afterB.files,beforeB.files);for(const watcher of runtime.watchers)watcher.close();
}));

test('Core an applied empty declarative revision never falls back to an unrelated default home',()=>tempDatabase(async({root,database})=>{
  const defaultHome=path.join(root,'.codex'),watched=new Map(),configured=[];await mkdir(defaultHome);
  const config={codexHome:defaultHome,databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex')};
  const runtime=new AgentRuntime(database,config,{collectorFactory:(entry)=>({home:entry.localHome,accountId:entry.accountId,async reconcile(){}}),syncClient:{configureProfiles(rows){configured.push(rows.map(row=>row.accountId));},async sync(){return{configuration:null};}},watchImpl:(directory)=>{watched.set(directory,(watched.get(directory)??0)+1);return{close(){const remaining=watched.get(directory)-1;if(remaining)watched.set(directory,remaining);else watched.delete(directory);}};},applyOptions:{clock:()=>NOW,baseline:async()=>{},isolatedRoot:(_config,binding)=>path.join(root,'profiles',binding),launcherDirectory:path.join(root,'bin'),platform:'linux'}});
  runtime.running=true;await runtime.applyConfiguration(desired(1,[{bindingId:'a',accountId:'a',name:'A',mode:'isolated'}]));assert.equal(runtime.collectors.length,1);assert.equal(watched.size,3);
  await runtime.applyConfiguration(desired(2,[]));assert.equal(configurationState(database).appliedRevision,2);assert.deepEqual(assignmentRows(database),[]);assert.deepEqual(runtime.collectors,[]);assert.deepEqual(configured.at(-1),[]);assert.equal(watched.size,0);assert.equal([...watched.keys()].some(value=>value.startsWith(defaultHome)),false);assert.deepEqual(await runtime.reconcile(),[]);runtime.running=false;
}));

test('Core runtime start leaves an absent default home untouched after declarative opt-in',()=>tempDatabase(async({root,database})=>{
  const defaultHome=path.join(root,'untracked-default'),config={codexHome:defaultHome,databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex'),profiles:[],reconcileIntervalMs:999999,syncIntervalMs:999999,heartbeatIntervalMs:999999};
  await applyDesiredConfiguration(database,config,desired(1,[]),{clock:()=>NOW});const configured=[];const runtime=new AgentRuntime(database,config,{syncClient:{configureProfiles(rows){configured.push(rows);},async sync(){return{configuration:null};}},watchImpl:()=>{throw new Error('untracked home must not be watched');}});
  await runtime.start();assert.deepEqual(runtime.collectors,[]);assert.deepEqual(configured.at(-1),[]);await assert.rejects(stat(defaultHome));await runtime.stop();
}));

test('Core default-home real rollout baselines old usage, uploads only new usage, and rebinds without reassignment',()=>tempDatabase(async({root,database})=>{
  const home=path.join(root,'.codex'),rollout=path.join(home,'sessions','2026','09','01','rollout-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl');await mkdir(path.dirname(rollout),{recursive:true});await writeFile(rollout,META('cccccccc-cccc-4ccc-8ccc-cccccccccccc')+USAGE(100,0));await writeFile(path.join(home,'config.toml'),'theme = "safe"\n');await writeFile(path.join(home,'auth.json'),'opaque');
  const protectedBefore=await Promise.all(['config.toml','auth.json'].map(async name=>[name,await readFile(path.join(home,name),'utf8'),(await stat(path.join(home,name))).mtimeMs]));
  const serverRoot=await mkdtemp(path.join(os.tmpdir(),'codex-meter-default-server-')),serverDb=openServerDatabase(path.join(serverRoot,'server.db'));let serverNow=NOW;
  try{
    const service=new MeterService(serverDb,{adminPassword:'long enough test password',clock:()=>serverNow});serverDb.prepare("INSERT INTO groups(id,name,created_at,updated_at) VALUES('group','Group',?,?)").run(new Date(NOW).toISOString(),new Date(NOW).toISOString());addServerDevice(serverDb,'device');serverDb.prepare("UPDATE devices SET current_group_id='group' WHERE id='device'").run();serverDb.prepare("INSERT INTO device_group_memberships(id,device_id,group_id,valid_from) VALUES('membership','device','group',?)").run(new Date(NOW).toISOString());
    const personal=service.createAccount({name:'Personal'}),research=service.createAccount({name:'Research'});service.bindAccount('device',{accountId:personal.id,mode:'default'});let device=serverDb.prepare("SELECT * FROM devices WHERE id='device'").get();
    const config={serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:home,databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex'),maxBatchSize:100};
    const fetchImpl=async(_url,options)=>new Response(JSON.stringify(service.sync(device,JSON.parse(options.body),CAPS)),{status:200,headers:{'content-type':'application/json'}});const client=new AgentSyncClient(database,config,{clock:()=>serverNow,fetchImpl});const runtime=new AgentRuntime(database,config,{syncClient:client,applyOptions:{clock:()=>serverNow,baseline:(collector)=>collector.reconcile()}});
    await runtime.applyConfiguration(service.desiredConfiguration('device'));assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,0);await appendFile(rollout,USAGE(25,21));await runtime.collectors[0].reconcile();serverNow+=120_000;await runtime.sync();assert.equal(service.accountDetail(personal.id).measured.totalTokens,'25');assert.equal(service.usage('all',{deviceId:'device'}).measured.totalTokens,'25');assert.equal(service.usage('all',{groupId:'group'}).measured.totalTokens,'25');
    serverNow+=120_000;const oldBinding=service.deviceDetail('device').profiles.find(item=>item.accountId===personal.id);service.disableBinding('device',oldBinding.id);service.bindAccount('device',{accountId:research.id,mode:'default'});device=serverDb.prepare("SELECT * FROM devices WHERE id='device'").get();await runtime.applyConfiguration(service.desiredConfiguration('device'));await appendFile(rollout,USAGE(30,25));await runtime.collectors[0].reconcile();serverNow+=120_000;await runtime.sync();
    assert.equal(service.accountDetail(personal.id).measured.totalTokens,'25');assert.equal(service.accountDetail(research.id).measured.totalTokens,'30');assert.equal(service.usage('all',{deviceId:'device'}).measured.totalTokens,'55');assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,0);
    assert.deepEqual(await Promise.all(['config.toml','auth.json'].map(async name=>[name,await readFile(path.join(home,name),'utf8'),(await stat(path.join(home,name))).mtimeMs])),protectedBefore);await assert.rejects(stat(path.join(home,'.codex-meter-profile.json')));
  }finally{serverDb.close();await rm(serverRoot,{recursive:true,force:true});}
}));

// Real quota observation promises stay inside the runtime's serialized operation.
test('Core real quota observations serialize with add, disable, and failed revision apply',()=>tempDatabase(async({root,database})=>{
  const config={serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex'),maxBatchSize:100};let gate=null;const created=[];
  const quotaReporterFactory=(entry)=>{const reporter={accountId:entry.accountId,async observe(){if(gate&&gate.accountId===entry.accountId){gate.started();await gate.promise;}return{accountId:entry.accountId,observedAt:new Date(NOW).toISOString(),status:'available',planType:null,windows:[]};}};created.push(reporter);return reporter;};
  const client=new AgentSyncClient(database,config,{clock:()=>NOW,quotaReporterFactory,fetchImpl:async()=>new Response(JSON.stringify({acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[],serverTime:new Date(NOW).toISOString(),isQuotaReporter:false,serverCapabilities:CAPS,agentConfiguration:null}),{status:200,headers:{'content-type':'application/json'}})});const runtime=new AgentRuntime(database,config,{syncClient:client,applyOptions:{clock:()=>NOW,baseline:async()=>{},isolatedRoot:(_config,binding)=>path.join(root,'profiles',binding),launcherDirectory:path.join(root,'bin'),platform:'linux'}});
  await runtime.applyConfiguration(desired(1,[{bindingId:'personal-binding',accountId:'personal',name:'Personal',mode:'default'}]));
  const overlap=async(accountId,configuration)=>{let release,start;const promise=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{start=resolve;});gate={accountId,promise,started:start};const observing=runtime.sync(true);await started;const applying=runtime.applyConfiguration(configuration);release();const result=await observing;const applied=await applying;gate=null;return{result,applied};};
  const added=await overlap('personal',desired(2,[{bindingId:'personal-binding',accountId:'personal',name:'Personal',mode:'default'},{bindingId:'research-binding',accountId:'research',name:'Research',mode:'isolated'}]));assert.equal(added.applied.applied,true,added.applied.error?.stack);assert.deepEqual(client.profileQuotaReporters.map(item=>item.accountId).sort(),['personal','research']);assert.equal(assignmentRows(database).find(row=>row.accountId==='personal').state,'quota_available');assert.equal(database.prepare("SELECT status FROM profile_quota_status WHERE account_id='research'").get(),undefined);
  await overlap('personal',desired(3,[{bindingId:'research-binding',accountId:'research',name:'Research',mode:'isolated'}]));assert.deepEqual(client.profileQuotaReporters.map(item=>item.accountId),['research']);assert.equal(assignmentRows(database,{activeOnly:false}).find(row=>row.accountId==='personal').state,'stopped');
  const lkgReporters=client.profileQuotaReporters;const failed=await overlap('research',desired(4,[{bindingId:'research-binding',accountId:'research',name:'Research',mode:'default'},{bindingId:'other-binding',accountId:'other',name:'Other',mode:'default'}]));assert.equal(failed.applied.applied,false);assert.equal(configurationState(database).status,'apply_failed');assert.equal(configurationState(database).appliedRevision,3);assert.equal(client.profileQuotaReporters,lkgReporters);assert.equal(created.filter(item=>item.accountId==='research').length>=1,true);
}));

test('Core remote disable during quota observation retries without stale quota and applies the new revision',()=>tempDatabase(async({root,database})=>{
  const serverRoot=await mkdtemp(path.join(os.tmpdir(),'codex-meter-quota-disable-server-')),serverDb=openServerDatabase(path.join(serverRoot,'server.db'));let releaseObservation,startObservation;const observationGate=new Promise(resolve=>{releaseObservation=resolve;}),observationStarted=new Promise(resolve=>{startObservation=resolve;});
  try{
    const service=new MeterService(serverDb,{adminPassword:'long enough test password',clock:()=>NOW}),device=addServerDevice(serverDb,'device'),personal=service.createAccount({name:'Personal'}),binding=service.bindAccount(device.id,{accountId:personal.id,mode:'default'}),requests=[];
    const config={serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'x'.repeat(32),codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex'),maxBatchSize:100};
    const client=new AgentSyncClient(database,config,{clock:()=>NOW,quotaReporterFactory:(entry)=>({accountId:entry.accountId,async observe(){startObservation();await observationGate;return{accountId:entry.accountId,observedAt:new Date(NOW).toISOString(),status:'unavailable',errorKind:'not_authenticated',planType:null,windows:[]};}}),fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);try{return new Response(JSON.stringify(service.sync(serverDb.prepare("SELECT * FROM devices WHERE id='device'").get(),body,CAPS)),{status:200,headers:{'content-type':'application/json'}});}catch(error){if(error instanceof ServiceError)return new Response(JSON.stringify({error:error.code,message:error.message}),{status:error.status,headers:{'content-type':'application/json'}});throw error;}}});
    const runtime=new AgentRuntime(database,config,{syncClient:client,collectorFactory:(entry)=>({home:entry.localHome,accountId:entry.accountId,async reconcile(){}}),applyOptions:{clock:()=>NOW,baseline:async()=>{}}});await runtime.applyConfiguration(service.desiredConfiguration(device.id));
    const syncing=runtime.sync(true);await observationStarted;service.disableBinding(device.id,binding.id);releaseObservation();const result=await syncing;
    assert.equal(result.configurationApply.applied,true);assert.equal(configurationState(database).appliedRevision,2);assert.deepEqual(assignmentRows(database),[]);assert.deepEqual(runtime.collectors,[]);assert.deepEqual(client.profileQuotaReporters,[]);assert.equal(requests.length,2);assert.deepEqual(requests[0].quotaReports.map(report=>report.accountId),[personal.id]);assert.equal('quotaReports'in requests[1],false);assert.equal(serverDb.prepare('SELECT COUNT(*) count FROM account_quota_snapshots WHERE account_id=?').get(personal.id).count,0);
  }finally{serverDb.close();await rm(serverRoot,{recursive:true,force:true});}
}));

test('Core captured watcher callbacks never reactivate obsolete collectors across revision apply',()=>tempDatabase(async({root,database})=>{
  const callbacks=[],collectors=[];let openWatchers=0,releaseBaseline,startBaseline;const baselineGate=new Promise(resolve=>{releaseBaseline=resolve;}),baselineStarted=new Promise(resolve=>{startBaseline=resolve;});
  const collectorFactory=(entry)=>{const collector={home:entry.localHome,accountId:entry.accountId,count:0,async reconcile(){collector.count+=1;}};collectors.push(collector);return collector;};const watchImpl=(_directory,_options,callback)=>{callbacks.push(callback);openWatchers+=1;let closed=false;return{close(){if(!closed){closed=true;openWatchers-=1;}}};};
  const config={codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex')};const runtime=new AgentRuntime(database,config,{collectorFactory,watchImpl,syncClient:{configureProfiles(){},async sync(){return{configuration:null};}},applyOptions:{clock:()=>NOW,isolatedRoot:(_config,binding)=>path.join(root,'profiles',binding),launcherDirectory:path.join(root,'bin'),platform:'linux',baseline:async(_collector,entry)=>{if(entry.accountId==='b'){startBaseline();await baselineGate;}}}});runtime.running=true;
  await runtime.applyConfiguration(desired(1,[{bindingId:'a',accountId:'a',name:'A',mode:'default'}]));const obsolete=runtime.collectors[0],oldCallbacks=callbacks.slice();assert.equal(openWatchers,3);
  const applying=runtime.applyConfiguration(desired(2,[{bindingId:'a',accountId:'a',name:'A',mode:'default'},{bindingId:'b',accountId:'b',name:'B',mode:'isolated'}]));await baselineStarted;oldCallbacks[0]();releaseBaseline();await applying;await new Promise(resolve=>setImmediate(resolve));await runtime.operation;assert.equal(obsolete.count,0);assert.equal(openWatchers,6);assert.deepEqual(runtime.collectors.map(item=>item.count),[1,1]);
  oldCallbacks[1]();await new Promise(resolve=>setImmediate(resolve));await runtime.operation;assert.equal(obsolete.count,0);assert.deepEqual(runtime.collectors.map(item=>item.count),[2,2]);assert.equal(openWatchers,6);runtime.running=false;for(const watcher of runtime.watchers)watcher.close();assert.equal(openWatchers,0);
}));

test('Core partial isolated-home failure keeps revision N active and retries idempotently',()=>tempDatabase(async({root,database})=>{
  const config={codexHome:path.join(root,'.codex'),databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex')};const options={clock:()=>NOW,isolatedRoot:(_config,binding)=>binding==='a'?path.join(root,'Home A'):path.join(root,'blocked','Home B'),launcherDirectory:path.join(root,'bin'),platform:'linux',baseline:async()=>{}};
  await applyDesiredConfiguration(database,config,desired(1,[{bindingId:'stable',accountId:'stable',name:'Stable',mode:'default'}]),options);await writeFile(path.join(root,'blocked'),'not a directory');
  const candidate=desired(2,[{bindingId:'a',accountId:'a',name:'A',mode:'isolated'},{bindingId:'b',accountId:'b',name:'B',mode:'isolated'}]);const failed=await applyDesiredConfiguration(database,config,candidate,options);assert.equal(failed.applied,false);assert.equal(configurationState(database).appliedRevision,1);assert.equal(configurationState(database).errorKind,'profile_apply_failed');assert.equal(configurationState(database).errorKind.includes(root),false);assert.deepEqual(assignmentRows(database).map(row=>row.accountId),['stable']);assert.equal(JSON.parse(await readFile(path.join(root,'Home A','.codex-meter-profile.json'),'utf8')).accountId,'a');assert.equal(database.prepare("SELECT COUNT(*) count FROM profile_assignments WHERE account_id IN ('a','b') AND active=1").get().count,0);assert.deepEqual(await readdir(path.join(root,'bin')),['cx1']);
  await rm(path.join(root,'blocked'));const retried=await applyDesiredConfiguration(database,config,candidate,options);assert.equal(retried.applied,true);assert.equal(configurationState(database).appliedRevision,2);assert.deepEqual(assignmentRows(database).map(row=>row.accountId).sort(),['a','b']);assert.deepEqual((await readdir(path.join(root,'bin'))).sort(),['cx1','cx2']);assert.deepEqual(assignmentRows(database).map(row=>row.launcherName).sort(),['cx1','cx2']);
}));

test('Core actual-state validation is enforced over HTTP without corrupting last-known-good state',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-http-state-')),database=openServerDatabase(path.join(root,'server.db')),server=createV2Server({database,adminPassword:'long enough test password',clock:()=>NOW});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const enrollment=server.service.createDevice({name:'Device'}),credentials=server.service.enroll({token:enrollment.enrollmentToken},CAPS),account=server.service.createAccount({name:'Personal'}),other=server.service.createAccount({name:'Other'});const binding=server.service.bindAccount(credentials.deviceId,{accountId:account.id,mode:'default'}),temporary=server.service.bindAccount(credentials.deviceId,{accountId:other.id,mode:'isolated'});server.service.disableBinding(credentials.deviceId,temporary.id);database.prepare('DELETE FROM device_configuration_revisions WHERE device_id=? AND revision=2').run(credentials.deviceId);
    const address=server.address(),url=`http://127.0.0.1:${address.port}/api/v1/agent/sync`,base={agentVersion:'2.1-test',codexVersion:null,events:[],health:{status:'healthy'}};
    const request=async(stateValue,capability=AGENT_CAPABILITY_HEADER_VALUE)=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https',authorization:`Bearer ${credentials.deviceId}.${credentials.deviceSecret}`,[AGENT_CAPABILITY_HEADER]:capability},body:JSON.stringify({...base,...(stateValue?{configurationState:stateValue}:{})})});return{status:response.status,body:await response.json()};};
    const valid={desiredRevision:3,appliedRevision:3,status:'healthy',errorKind:null,profiles:[profile(binding.id,account.id)]};assert.deepEqual((await request(valid)).status,200);
    const snapshot=()=>({device:{...database.prepare('SELECT desired_config_revision,applied_config_revision,configuration_status,configuration_error_kind,configuration_reported_at FROM devices WHERE id=?').get(credentials.deviceId)},profiles:database.prepare('SELECT binding_id,account_id,mode,state,launcher_name FROM device_profile_status WHERE device_id=? ORDER BY binding_id').all(credentials.deviceId)}),before=snapshot();
    const cases=[
      [{...valid,appliedRevision:2,status:'apply_failed',errorKind:'stale',profiles:[]},'stale_configuration_revision'],
      [{...valid,profiles:[]},'missing_configuration_profile'],
      [{...valid,profiles:[...valid.profiles,profile('extra',account.id)]},'extra_configuration_profile'],
      [{...valid,profiles:[profile(binding.id,'wrong-account')]},'wrong_configuration_account'],
      [{...valid,profiles:[profile(binding.id,account.id,'isolated')]},'wrong_configuration_mode'],
      [{...valid,profiles:[{...profile(binding.id,account.id),launcher:'sudo'}]},'invalid_configuration_state'],
      [{...valid,status:'apply_failed',errorKind:'failed'},'invalid_configuration_state']
    ];
    for(const [candidate,code] of cases){const response=await request(candidate);assert.equal(response.status,400,code);assert.equal(response.body.error,code);assert.deepEqual(snapshot(),before);}
    const malformed=await request(valid,`${AGENT_CAPABILITY_HEADER_VALUE};unknown=1`);assert.equal(malformed.status,400);assert.equal(malformed.body.error,'invalid_capabilities');assert.deepEqual(snapshot(),before);
  }finally{await new Promise(resolve=>server.close(resolve));database.close();await rm(root,{recursive:true,force:true});}
});
