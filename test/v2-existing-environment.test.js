import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import tty from 'node:tty';
import readlinePromises from 'node:readline/promises';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { openAgentDatabase } from '../v2/agent/database.js';
import { openServerDatabase } from '../v2/server/database.js';
import { MeterService } from '../v2/server/service.js';
import { AgentRuntime } from '../v2/agent/runtime.js';
import { AgentCollector } from '../v2/agent/collector.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
import { applyDesiredConfiguration, assignmentRows, configurationState, validateDesiredConfiguration } from '../v2/agent/assignments.js';
import { attachExistingHome, pendingExistingProfiles, selectExistingProfiles } from '../v2/agent/attach-existing.js';
import { validateExistingHome, discoverExistingRollouts } from '../v2/agent/existing-home.js';
import { validateConfig, saveConfig } from '../v2/agent/config.js';
import { runAgentCli } from '../v2/agent/cli.js';
import { SERVER_CAPABILITIES, EXISTING_HOME_HEADER, AGENT_CAPABILITY_HEADER, AGENT_CAPABILITY_HEADER_VALUE } from '../v2/shared/capabilities.js';
import { migrateDatabase } from '../v2/shared/sqlite.js';
import { quotaScratchRoot } from '../v2/agent/existing-quota-runner.js';
import { existingRootKey } from '../v2/agent/existing-root.js';
import { findEnvironmentCandidates } from '../v2/agent/environment-candidates.js';

const NOW=Date.now();
const capabilities={...SERVER_CAPABILITIES,existingHomeSelection:true};
const declaration=(id='personal')=>({accountId:id,bindingId:`binding-${id}`,name:id==='personal'?'Personal':'Research',mode:'existing',selectionKey:`selection-${id}`});
const desired=(profiles=[declaration()],revision=1)=>({schemaVersion:1,revision,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles});
const usage=(tokens,minute=1)=>`${JSON.stringify({timestamp:new Date(NOW+minute*60000).toISOString(),type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:tokens,total_tokens:tokens,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}})}\n`;
async function fixture(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-existing-'));
  const database=openAgentDatabase(path.join(root,'agent.db')),serverDatabase=openServerDatabase(path.join(root,'server.db'));
  const homes=['cx1','cx2'].map(name=>path.join(root,'home','test','.codex-profiles',name));
  const files=[];
  for(const [index,home] of homes.entries()){
    await mkdir(path.join(home,'sessions'),{recursive:true});
    const id=`11111111-1111-4111-8111-11111111111${index}`;
    const filename=path.join(home,'sessions',`rollout-${id}.jsonl`);files.push(filename);
    await writeFile(filename,`${JSON.stringify({type:'session_meta',payload:{id,source:'cli'}})}\n${usage(100,0)}`);
    await writeFile(path.join(home,'config.toml'),'custom = "preserve"\n');
    await writeFile(path.join(home,'auth.json'),'AUTH SENTINEL NOT JSON AND MUST NOT BE PARSED');
  }
  const config=validateConfig({deviceId:'device',deviceSecret:'test-secret-for-fixture-only-1234567890',serverUrl:'https://meter.example',databasePath:path.join(root,'agent.db'),codexHome:homes[1]});
  const service=new MeterService(serverDatabase,{adminPassword:'existing test password',clock:()=>NOW});
  try{await run({root,database,serverDatabase,homes,files,config,service});}
  finally{if(database.isOpen)database.close();if(serverDatabase.isOpen)serverDatabase.close();await rm(root,{recursive:true,force:true});}
}
async function snapshot(home){
  const entries=await readdir(home,{recursive:true});const rows=[];
  for(const entry of entries.sort()){const filename=path.join(home,entry),info=await stat(filename);rows.push([entry,info.mtimeMs,info.mode,info.isFile()?await readFile(filename,'utf8'):null]);}
  return rows;
}
function quiet(){let text='';return{write(value){text+=value;},get text(){return text;}};}

test('Meter-owned quota runtime namespace is rejected before existing Home filesystem validation',async()=>{
  const reserved=quotaScratchRoot();
  if(reserved){
    await assert.rejects(validateExistingHome(path.join(reserved,'not-created')),/runtime directories/);
    await assert.rejects(validateExistingHome(reserved),/runtime directories/);
  }else assert.equal(reserved,null);
});

test('A pre-identity existing assignment waits for explicit local re-selection and preserves history without JSON edits or restart',()=>fixture(async({database,config,homes,files})=>{
  await applyDesiredConfiguration(database,config,desired());await attachExistingHome(database,config,declaration(),homes[0]);await activate(database,config);
  database.prepare('DELETE FROM agent_state WHERE key=?').run(existingRootKey('personal:selection-personal'));
  assert.equal(assignmentRows(database)[0].localHome,null);assert.equal(configurationState(database).profiles[0].state,'local_selection_required');
  assert.equal(pendingExistingProfiles(database).length,1);
  await appendFile(files[0],usage(777));
  await selectExistingProfiles(database,config,{home:homes[0],output:quiet()});await activate(database,config);
  assert.equal(pendingExistingProfiles(database).length,0);assert.equal(assignmentRows(database)[0].localHome,homes[0]);
  assert.ok(assignmentRows(database)[0].rootIdentity);assert.equal(database.prepare('SELECT COUNT(*) n FROM usage_outbox').get().n,0);
}));

test('Explicit local candidate chooser attaches exact Profile and Home only after selection, with EOF baseline and private wire state',()=>fixture(async({database,config,homes,files})=>{
  await applyDesiredConfiguration(database,config,desired([declaration(),declaration('research')]));
  const beforeB=await snapshot(homes[1]),output=quiet(),answers=['2','1'];
  await selectExistingProfiles(database,config,{discover:true,searchRoots:[path.dirname(homes[0])],output,question:async()=>{
    assert.equal(database.prepare('SELECT COUNT(*) n FROM existing_home_selections').get().n,0);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,0);
    return answers.shift();
  }});
  const mapping=database.prepare('SELECT account_id,canonical_home FROM existing_home_selections').get();
  assert.equal(mapping.account_id,'research');assert.equal(mapping.canonical_home,homes[0]);
  assert.equal(database.prepare('SELECT byte_offset FROM rollout_cursors').get().byte_offset,(await stat(files[0])).size);
  assert.match(output.text,/not verified accounts/);assert.match(output.text,/cx1/);assert.match(output.text,/cx2/);
  assert.deepEqual(await snapshot(homes[1]),beforeB);
  assert.equal(JSON.stringify(configurationState(database)).includes(homes[0]),false);
  assert.equal(JSON.stringify(configurationState(database)).includes(homes[1]),false);
  await appendFile(files[0],usage(25));await appendFile(files[1],usage(999));await activate(database,config);
  assert.deepEqual(database.prepare('SELECT account_id,total_tokens FROM usage_outbox').all().map(row=>[row.account_id,row.total_tokens]),[['research',25]]);
}));

test('Local discovery cancellation and non-TTY invocation never attach or establish baselines',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired());
  const output=quiet();
  const cancelled=await selectExistingProfiles(database,config,{discover:true,searchRoots:[path.dirname(homes[0])],output,question:async()=>'c'});
  assert.equal(cancelled.selected,0);assert.match(output.text,/Cancelled/);
  const headless=quiet();
  await selectExistingProfiles(database,config,{discover:true,searchRoots:[path.dirname(homes[0])],input:{isTTY:false},output:headless,command:'actual-agent profile attach-existing'});
  assert.match(headless.text,/ACTION REQUIRED/);assert.doesNotMatch(headless.text,/cx1|cx2|Search folder/);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM existing_home_selections').get().n,0);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,0);
  await assert.rejects(selectExistingProfiles(database,config,{home:homes[0],discover:true}),/not both/);
  await assert.rejects(selectExistingProfiles(database,config,{discover:false,searchRoots:[path.dirname(homes[0])]}),/requires --discover/);
}));

test('M1 recreated candidate with reused dev/inode rejects 777 tokens before attachment or any baseline, then explicit reselection works',()=>fixture(async({database,config,homes,files})=>{
  await applyDesiredConfiguration(database,config,desired());
  const candidate=(await findEnvironmentCandidates({roots:[],direct:[homes[0]]})).identities.get(homes[0]);
  assert.ok(candidate);
  const before=database.prepare('SELECT * FROM agent_state ORDER BY key').all();
  // Delete the displayed environment and create a distinct replacement at the
  // same path. Model inode allocator reuse deterministically, without sleeps.
  await rm(homes[0],{recursive:true});await mkdir(path.dirname(files[0]),{recursive:true});
  await writeFile(files[0],`${JSON.stringify({type:'session_meta',payload:{source:'cli'}})}\n${usage(777)}`);
  const oldLstat=fsPromises.lstat;
  fsPromises.lstat=async(filename,...args)=>{
    const info=await oldLstat(filename,...args);
    if(filename===homes[0]&&args[0]?.bigint){
      info.dev=BigInt(candidate.dev);info.ino=BigInt(candidate.ino);
      info.birthtimeNs=BigInt(candidate.birthtimeNs)+1n;
      // The old path + dev + ino predicate accepts this replacement.
      assert.equal(String(info.dev),candidate.dev);assert.equal(String(info.ino),candidate.ino);
    }
    return info;
  };syncBuiltinESMExports();
  try{
    await assert.rejects(attachExistingHome(database,config,declaration(),homes[0],candidate),{code:'candidate_changed'});
    for(const table of ['existing_home_selections','rollout_cursors','usage_outbox'])assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
    assert.deepEqual(database.prepare('SELECT * FROM agent_state ORDER BY key').all(),before);
  }finally{fsPromises.lstat=oldLstat;syncBuiltinESMExports();}
  const fresh=(await findEnvironmentCandidates({roots:[],direct:[homes[0]]})).identities.get(homes[0]);
  await attachExistingHome(database,config,declaration(),homes[0],fresh);await activate(database,config);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM usage_outbox').get().n,0);
  await appendFile(files[0],usage(25));await activate(database,config);
  assert.deepEqual(database.prepare('SELECT account_id,total_tokens FROM usage_outbox').all().map(row=>[row.account_id,row.total_tokens]),[['personal',25]]);
}));

test('A displayed discovery candidate cannot redirect attachment through a later symlink or replacement directory',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired());
  const original=homes[0],saved=`${original}-saved`;
  await assert.rejects(selectExistingProfiles(database,config,{discover:true,searchRoots:[path.dirname(original)],output:quiet(),question:async()=>{
    await rename(original,saved);await symlink(homes[1],original,process.platform==='win32'?'junction':'dir');return '1';
  }}),/changed/);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM existing_home_selections').get().n,0);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,0);
  await rm(original);await rename(saved,original);
  await assert.rejects(selectExistingProfiles(database,config,{discover:true,searchRoots:[path.dirname(original)],output:quiet(),question:async()=>{
    await rename(original,saved);await mkdir(original);return '1';
  }}),/changed/);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM existing_home_selections').get().n,0);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,0);
}));

test('Installer controlling-terminal fallback keeps menus and candidate paths off redirected stdout',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired());
  const output=quiet(),terminal=quiet(),original={open:fs.openSync,close:fs.closeSync,read:tty.ReadStream,write:tty.WriteStream,reader:readlinePromises.createInterface,platform:Object.getOwnPropertyDescriptor(process,'platform')};
  // Exercise Unix controlling-terminal routing with fake streams on any host.
  Object.defineProperty(process,'platform',{value:'linux'});
  let descriptor=2000;
  fs.openSync=filename=>{assert.equal(filename,'/dev/tty');return descriptor++;};fs.closeSync=()=>{};
  tty.ReadStream=class extends PassThrough {};
  tty.WriteStream=class extends Writable{constructor(){super({write(chunk,_encoding,callback){terminal.write(chunk.toString());callback();}});}};
  readlinePromises.createInterface=({output:destination})=>({question:async prompt=>{destination.write(prompt);return 'c';},close(){}});
  syncBuiltinESMExports();
  try{
    await selectExistingProfiles(database,config,{discover:true,searchRoots:[path.dirname(homes[0])],tryTty:true,input:{isTTY:false},output});
    assert.equal(output.text,'');assert.match(terminal.text,/Personal/);assert.match(terminal.text,/cx1/);assert.match(terminal.text,/Environment number/);assert.match(terminal.text,/Cancelled/);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM existing_home_selections').get().n,0);
  }finally{fs.openSync=original.open;fs.closeSync=original.close;tty.ReadStream=original.read;tty.WriteStream=original.write;readlinePromises.createInterface=original.reader;Object.defineProperty(process,'platform',original.platform);syncBuiltinESMExports();}
}));

test('Discovery selection accepts Windows canonical case normalization without changing Profile mapping',()=>fixture(async({database,config,root,homes})=>{
  await applyDesiredConfiguration(database,config,desired());
  const mixed=path.join(path.dirname(homes[0]),'MixedCase');await rename(homes[0],mixed);
  const original={lstat:fsPromises.lstat,stat:fsPromises.stat,realpath:fsPromises.realpath,baseline:AgentCollector.prototype.baselineCurrent,platform:Object.getOwnPropertyDescriptor(process,'platform')};
  // Simulate only Windows case-insensitive metadata lookup; no native Windows
  // execution is claimed. Other tests exercise real EOF baselining.
  const physical=value=>{
    if(typeof value!=='string'||!value.toLowerCase().startsWith(root.toLowerCase()))return value;
    return (root+value.slice(root.length)).replace(/mixedcase/gi,'MixedCase');
  };
  for(const name of ['lstat','stat','realpath'])fsPromises[name]=(value,...options)=>original[name](physical(value),...options);
  AgentCollector.prototype.baselineCurrent=async()=>{};
  Object.defineProperty(process,'platform',{value:'win32'});syncBuiltinESMExports();
  try{
    await selectExistingProfiles(database,config,{discover:true,searchRoots:[path.dirname(mixed)],question:async()=>'1',output:quiet()});
    const selection=database.prepare('SELECT account_id,canonical_home FROM existing_home_selections').get();
    assert.equal(selection.account_id,'personal');assert.equal(selection.canonical_home,mixed.toLowerCase());
  }finally{for(const name of ['lstat','stat','realpath'])fsPromises[name]=original[name];AgentCollector.prototype.baselineCurrent=original.baseline;Object.defineProperty(process,'platform',original.platform);syncBuiltinESMExports();}
}));
function syncBody(){return{agentVersion:'candidate',codexVersion:null,events:[],health:{status:'healthy'}};}

test('Quota isolation failure remains precise locally and wire-compatible without path exposure or offline HTTP 400',()=>fixture(async({database,config})=>{
  const requests=[];
  const sync=new AgentSyncClient(database,config,{quotaReporterFactory:entry=>({observe:async()=>({accountId:entry.accountId,observedAt:new Date().toISOString(),status:'unavailable',errorKind:'write_isolation_failed',planType:null,windows:[]})}),fetchImpl:async(_url,options)=>{
    requests.push(JSON.parse(options.body));return new Response(JSON.stringify({acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[],serverTime:new Date().toISOString(),isQuotaReporter:false}),{status:200});
  }});
  // Factory injection exercises the failure wire adapter without launching Codex.
  sync.configureProfiles([{accountId:'personal',mode:'isolated'}]);
  await sync.sync({heartbeat:true});
  assert.equal(database.prepare("SELECT error_kind FROM profile_quota_status WHERE account_id='personal'").get().error_kind,'write_isolation_failed');
  assert.equal(requests[0].quotaReports[0].errorKind,'app_server_unavailable');
  assert.equal(database.prepare("SELECT value FROM agent_state WHERE key='last_sync_status'").get().value,'ok');
  assert.equal(JSON.stringify(requests).includes(config.codexHome),false);
}));
async function activate(database,config){const runtime=new AgentRuntime(database,config,{syncClient:{configureProfiles(){}}});await runtime.reconcile();await runtime.stop();}

test('Existing logical binding, desired wire privacy, capability gate, and old-Agent compatible revisions honor explicit stops',()=>fixture(async({service,serverDatabase})=>{
  const account=service.createAccount({name:'Personal'}),enrollment=service.createDevice({name:'WSL Laptop',accountId:account.id,mode:'existing'});
  assert.throws(()=>service.enroll({token:enrollment.enrollmentToken},SERVER_CAPABILITIES),error=>error.code==='compatible_agent_required'||error.message==='compatible_agent_required');
  const credentials=service.enroll({token:enrollment.enrollmentToken},capabilities);
  assert.equal(credentials.agentConfiguration.profiles[0].mode,'existing');
  assert.equal(credentials.existingHomeSelection,true);
  assert.deepEqual(Object.keys(credentials.agentConfiguration.profiles[0]).sort(),['accountId','bindingId','mode','name','selectionKey']);
  assert.equal(JSON.stringify(credentials.agentConfiguration).includes('home/'),false);
  assert.deepEqual(service.desiredConfiguration(credentials.deviceId,false).profiles,[]);
  const oldEnrollment=service.createDevice({name:'Old Device'}),old=service.enroll({token:oldEnrollment.enrollmentToken},SERVER_CAPABILITIES);
  const binding=service.bindAccount(old.deviceId,{accountId:account.id,mode:'default'});
  const oldDesired=service.desiredConfiguration(old.deviceId,false);
  const research=service.createAccount({name:'Research'});service.bindAccount(old.deviceId,{accountId:research.id,mode:'existing'});
  assert.deepEqual(service.desiredConfiguration(old.deviceId,false).profiles,oldDesired.profiles);
  assert.ok(service.desiredConfiguration(old.deviceId,false).revision>oldDesired.revision);
  assert.equal(service.deviceDetail(old.deviceId).profiles.find(row=>row.accountId===research.id).trackingState,'waiting_for_compatible_agent');
  assert.equal(service.desiredConfiguration(old.deviceId,false).profiles[0].bindingId,binding.id);
  const device=serverDatabase.prepare('SELECT * FROM devices WHERE id=?').get(old.deviceId);
  assert.equal(service.sync(device,syncBody(),SERVER_CAPABILITIES).agentConfiguration.profiles.some(p=>p.mode==='existing'),false);
  service.disableBinding(old.deviceId,binding.id);
  const compatibleStopped=service.desiredConfiguration(old.deviceId,false);
  assert.deepEqual(compatibleStopped.profiles,[]);
  assert.ok(service.desiredConfiguration(old.deviceId,true).revision>compatibleStopped.revision);
}));

test('Unresolved existing has local_selection_required and zero default collectors, watchers, reporters, or baselines',()=>fixture(async({database,config,homes})=>{
  const before=await snapshot(homes[1]);await applyDesiredConfiguration(database,config,desired());
  const created=[],watched=[],probed=[];
  const runtime=new AgentRuntime(database,config,{collectorFactory:entry=>{created.push(entry.localHome);return{};},quotaReporterFactory:entry=>{probed.push(entry.localHome);return{};},watchImpl:root=>{watched.push(root);return{close(){}};}});
  runtime.refreshWatchers();assert.deepEqual(created,[]);assert.deepEqual(watched,[]);assert.deepEqual(probed,[]);
  assert.equal(runtime.syncClient.quotaReporter,null);
  assert.equal(configurationState(database).profiles[0].state,'local_selection_required');
  assert.equal(assignmentRows(database)[0].localHome,null);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,0);
  assert.deepEqual(await snapshot(homes[1]),before);
}));

test('Local CLI exact profile selection hot-activates only Home A; baseline 100 excluded, new 25 attributed, quota and wire isolated',()=>fixture(async({database,config,homes,files})=>{
  const beforeA=await snapshot(homes[0]),beforeB=await snapshot(homes[1]),probed=[],watched=[],wire=[];
  await applyDesiredConfiguration(database,config,desired());
  const client=new AgentSyncClient(database,config,{clock:()=>NOW+120000,quotaReporterFactory:entry=>({accountId:entry.accountId,home:entry.localHome,async observe(){probed.push(entry.localHome);return{accountId:entry.accountId,status:'unavailable',errorKind:'not_authenticated',observedAt:new Date(NOW).toISOString(),windows:[]};}}),fetchImpl:async(_url,init)=>{wire.push(JSON.parse(init.body));return new Response(JSON.stringify({acceptedEventIds:wire.at(-1).events.map(e=>e.eventId),duplicateEventIds:[],rejectedEvents:[],serverTime:new Date(NOW).toISOString(),serverCapabilities:SERVER_CAPABILITIES,existingHomeSelection:true}),{status:200});}});
  const runtime=new AgentRuntime(database,config,{syncClient:client,watchImpl:root=>{watched.push(root);return{close(){}};}});runtime.running=true;
  const output=quiet();const answers=['0',homes[0]];
  await selectExistingProfiles(database,config,{question:async()=>answers.shift(),output,command:'installed-agent profile attach-existing'});
  assert.match(output.text,/Account Profile: Personal/);assert.doesNotMatch(output.text,/binding-personal|selection-personal/);
  assert.equal(database.prepare('SELECT byte_offset FROM rollout_cursors').get().byte_offset,(await stat(files[0])).size);
  assert.deepEqual(await snapshot(homes[0]),beforeA);
  assert.deepEqual(await snapshot(homes[1]),beforeB);
  await appendFile(files[0],usage(25));await appendFile(files[1],usage(999));
  await runtime.reconcile();assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[0]]);
  assert.equal(watched.some(root=>root.startsWith(homes[1])),false);
  assert.deepEqual(database.prepare('SELECT account_id,total_tokens FROM usage_outbox').all().map(row=>[row.account_id,row.total_tokens]),[['personal',25]]);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,1);
  await runtime.sync(true);await runtime.sync(true);
  assert.deepEqual(probed,[homes[0],homes[0]]);assert.equal(assignmentRows(database)[0].state,'login_required');
  for(const forbidden of [...homes,'cx1','cx2','AUTH SENTINEL','canonical_home','localHome','selectionKey'])assert.equal(JSON.stringify(wire).includes(forbidden),false,forbidden);
  assert.equal(wire[0].events[0].accountId,'personal');assert.equal(wire[0].events[0].totalTokens,'25');
  assert.equal(wire[1].configurationState.profiles[0].mode,'existing');
  for(const home of homes){assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),'custom = "preserve"\n');assert.equal(await readFile(path.join(home,'auth.json'),'utf8'),'AUTH SENTINEL NOT JSON AND MUST NOT BE PARSED');assert.equal((await readdir(home)).includes('.codex-meter-profile.json'),false);}
  await runtime.stop();
}));

test('Two explicitly selected existing Homes isolate usage and quota across stop and runtime restart',()=>fixture(async({database,config,homes,files,service,serverDatabase})=>{
  const pro=service.createAccount({name:'procodex profile'}),sd=service.createAccount({name:'sdcodex profile'});
  const credentials=service.enroll({token:service.createDevice({name:'Fixture Laptop',accountId:pro.id,mode:'existing'}).enrollmentToken},capabilities);
  service.bindAccount(credentials.deviceId,{accountId:sd.id,mode:'existing'});
  service.clock=()=>NOW+120000;
  const localConfig={...config,deviceId:credentials.deviceId,deviceSecret:credentials.deviceSecret},wire=[],probes=[];
  await applyDesiredConfiguration(database,localConfig,service.desiredConfiguration(credentials.deviceId));
  const options={watchImpl:()=>({close(){}}),quotaReporterFactory:entry=>({accountId:entry.accountId,async observe(){
    probes.push([entry.accountId,entry.localHome]);
    return{accountId:entry.accountId,status:'available',observedAt:new Date(NOW).toISOString(),planType:'plus',windows:[{limitId:'codex',durationMinutes:300,usedPercent:entry.accountId===pro.id?11:77,resetsAt:new Date(NOW+3600000).toISOString(),slot:'primary'}]};
  }}),fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body);wire.push(body);
    return new Response(JSON.stringify(service.sync(service.authenticateDevice(credentials.deviceId,credentials.deviceSecret),body,capabilities)),{status:200});
  }};
  let runtime=new AgentRuntime(database,localConfig,options);
  const totals=()=>[service.accountDetail(pro.id).measured.totalTokens,service.accountDetail(sd.id).measured.totalTokens];
  try{
    await selectExistingProfiles(database,localConfig,{profileName:pro.name,home:homes[0],output:quiet()});
    await appendFile(files[0],usage(25));await appendFile(files[1],usage(40));await runtime.reconcile();await runtime.sync(true);
    assert.deepEqual(totals(),['25','0']);assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[0]]);
    assert.ok(probes.length>0);assert.ok(probes.every(([account,home])=>account===pro.id&&home===homes[0]));
    await selectExistingProfiles(database,localConfig,{profileName:sd.name,home:homes[1],output:quiet()});
    await appendFile(files[0],usage(7));await appendFile(files[1],usage(9));await runtime.reconcile();await runtime.sync(true);
    assert.deepEqual(totals(),['32','9']);
    assert.equal(service.accountQuota(pro.id).windows[0].usedPercent,11);assert.equal(service.accountQuota(sd.id).windows[0].usedPercent,77);
    for(const[account,home]of probes)assert.equal(home,account===pro.id?homes[0]:homes[1]);
    const binding=service.desiredConfiguration(credentials.deviceId).profiles.find(row=>row.accountId===pro.id);
    service.disableBinding(credentials.deviceId,binding.bindingId);await runtime.applyConfiguration(service.desiredConfiguration(credentials.deviceId));
    probes.length=0;
    await appendFile(files[0],usage(333));await appendFile(files[1],usage(4));await runtime.reconcile();await runtime.sync(true);
    assert.deepEqual(totals(),['32','13']);
    await runtime.stop();runtime=new AgentRuntime(database,localConfig,options);
    await appendFile(files[0],usage(999));await appendFile(files[1],usage(5));await runtime.reconcile();await runtime.sync(true);await runtime.sync(true);
    assert.deepEqual(totals(),['32','18']);assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[1]]);
    assert.deepEqual(assignmentRows(database).map(row=>row.localHome),[homes[1]]);
    assert.ok(probes.length>0);assert.ok(probes.every(([account,home])=>account===sd.id&&home===homes[1]));
    const events=serverDatabase.prepare('SELECT COUNT(*) n,COUNT(DISTINCT event_id) unique_n FROM usage_events').get();
    assert.equal(events.n,5);assert.equal(events.unique_n,events.n);
    for(const home of homes){
      assert.equal(JSON.stringify(wire).includes(home),false);
      assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),'custom = "preserve"\n');
      assert.equal(await readFile(path.join(home,'auth.json'),'utf8'),'AUTH SENTINEL NOT JSON AND MUST NOT BE PARSED');
      assert.deepEqual((await readdir(home)).sort(),['auth.json','config.toml','sessions']);
    }
  }finally{await runtime.stop();}
}));

test('Stop and offline missed stop/re-add require fresh local selection, preserve history, and baseline off-period usage',()=>fixture(async({database,config,homes,files,service})=>{
  const account=service.createAccount({name:'Personal'}),pending=service.createDevice({name:'Laptop',accountId:account.id,mode:'existing'}),credentials=service.enroll({token:pending.enrollmentToken},capabilities);
  const first=credentials.agentConfiguration,profile=first.profiles[0];await applyDesiredConfiguration(database,config,first);await attachExistingHome(database,config,profile,homes[0]);
  const client={configureProfiles(){},async sync(){return{};}},runtime=new AgentRuntime(database,config,{syncClient:client});
  await appendFile(files[0],usage(25));await runtime.reconcile();const historical=database.prepare('SELECT * FROM usage_outbox').all();const before=await snapshot(homes[0]);
  service.disableBinding(credentials.deviceId,profile.bindingId);service.bindAccount(credentials.deviceId,{accountId:account.id,mode:'existing'});
  const readded=service.desiredConfiguration(credentials.deviceId);assert.notEqual(readded.profiles[0].selectionKey,profile.selectionKey);
  await runtime.applyConfiguration(readded);assert.equal(runtime.collectors.length,0);assert.equal(pendingExistingProfiles(database).length,1);assert.deepEqual(await snapshot(homes[0]),before);
  await appendFile(files[0],usage(50,2));await attachExistingHome(database,config,readded.profiles[0],homes[0]);await runtime.reconcile();assert.deepEqual(database.prepare('SELECT * FROM usage_outbox').all(),historical);
  await appendFile(files[0],usage(7,3));await runtime.reconcile();assert.deepEqual(database.prepare('SELECT total_tokens FROM usage_outbox').all().map(row=>row.total_tokens),[25,7]);
  await runtime.applyConfiguration(desired([],readded.revision+1));assert.equal(runtime.collectors.length,0);assert.equal(pendingExistingProfiles(database).length,0);
}));

test('Two unresolved profiles choose by readable name/number with no UUID and keep the other unresolved',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired([declaration(),declaration('research')]));
  const answers=['2','0',homes[0]],output=quiet();await selectExistingProfiles(database,config,{question:async()=>answers.shift(),output,command:'real-agent profile attach-existing'});
  assert.match(output.text,/1\. Personal\n2\. Research/);assert.doesNotMatch(output.text,/binding-|selection-/);
  await activate(database,config);
  assert.equal(assignmentRows(database).find(row=>row.name==='Research').localHome,homes[0]);assert.equal(pendingExistingProfiles(database)[0].name,'Personal');
  await assert.rejects(selectExistingProfiles(database,config,{home:homes[1],profileName:'missing',output}),/exact pending/);
}));

test('No TTY prints a concrete local command, never guesses a home',()=>fixture(async({database,config})=>{
  await applyDesiredConfiguration(database,config,desired());const output=quiet();
  const result=await selectExistingProfiles(database,config,{input:{isTTY:false},output,command:"'/home/test/.local/bin/codex-meter-agent' profile attach-existing"});
  assert.equal(result.selected,0);assert.match(output.text,/ACTION REQUIRED:\n'\/home\/test\/\.local\/bin\/codex-meter-agent' profile attach-existing/);assert.equal(assignmentRows(database)[0].localHome,null);
}));

test('CLI and IDE rollouts using the same selected Home remain one Native Profile',()=>fixture(async({database,config,homes,files})=>{
  const ide=path.join(homes[0],'sessions','rollout-11111111-1111-4111-8111-111111111119.jsonl');
  await writeFile(ide,JSON.stringify({type:'session_meta',payload:{id:'11111111-1111-4111-8111-111111111119',source:'vscode'}})+'\n'+usage(100,0));
  await applyDesiredConfiguration(database,config,desired());await attachExistingHome(database,config,declaration(),homes[0]);await activate(database,config);
  await appendFile(files[0],usage(25));await appendFile(ide,usage(30));
  const runtime=new AgentRuntime(database,config);await runtime.reconcile();
  const rows=database.prepare('SELECT account_id,total_tokens FROM usage_outbox').all();assert.equal(rows.length,2);assert.ok(rows.every(row=>row.account_id==='personal'));assert.equal(rows.reduce((n,row)=>n+row.total_tokens,0),55);await runtime.stop();
}));

test('CLI --codex-home works without UUID, config edit or service restart, including shell metacharacters',()=>fixture(async({root,database,config})=>{
  const home=path.join(root,"existing '$() ; & home");await mkdir(home);await applyDesiredConfiguration(database,config,desired());
  const filename=path.join(root,'agent.json');await saveConfig(filename,config);const before=await readFile(filename,'utf8'),output=quiet();
  assert.equal(await runAgentCli(['profile','attach-existing','--config',filename,'--codex-home',home],{stdout:output}),0);
  assert.equal(assignmentRows(database)[0].localHome,null);await activate(database,config);
  assert.equal(assignmentRows(database)[0].localHome,home);assert.equal(await readFile(filename,'utf8'),before);assert.deepEqual(await readdir(home),[]);
}));

test('Invalid paths, duplicate canonical homes, parent/child overlaps and session symlinks are rejected without mutation',()=>fixture(async({root,database,config,homes})=>{
  for(const invalid of ['',null,'bad\npath',path.join(root,'missing'),path.join(homes[0],'auth.json')])await assert.rejects(validateExistingHome(invalid));
  await applyDesiredConfiguration(database,config,desired([declaration(),declaration('research')]));await attachExistingHome(database,config,declaration(),homes[0]);
  const alias=path.join(root,'alias');await symlink(homes[0],alias,'dir');
  for(const duplicate of [homes[0],alias,path.dirname(homes[0]),path.join(homes[0],'sessions'),path.parse(root).root])await assert.rejects(attachExistingHome(database,config,declaration('research'),duplicate),/overlaps/);
  const outside=path.join(root,'outside');await mkdir(outside);await symlink(path.join(homes[1],'sessions'),path.join(outside,'sessions'),'dir');
  await assert.rejects(validateExistingHome(outside),/Session directories/);assert.equal(assignmentRows(database).find(p=>p.name==='Research').localHome,null);
}));

test('Canonical alias selection and nested symlinks never discover unselected Home B',()=>fixture(async({root,database,config,homes,files})=>{
  const alias=path.join(root,'alias');await symlink(homes[0],alias,'dir');await symlink(path.join(homes[1],'sessions'),path.join(homes[0],'sessions','external'),'dir');
  await applyDesiredConfiguration(database,config,desired());await attachExistingHome(database,config,declaration(),alias);
  await activate(database,config);
  assert.equal(assignmentRows(database)[0].localHome,homes[0]);const found=await discoverExistingRollouts({home:homes[0]});
  try{assert.deepEqual(found.files.map(f=>f.path),[files[0]]);}finally{await found.close();}
}));

test('Remote configuration cannot supply a path, command, shell script, launcher or traversal binding',()=>fixture(async({database,config,homes})=>{
  for(const key of ['codexHome','localHome','path','command','launcher'])assert.throws(()=>validateDesiredConfiguration(desired([{...declaration(),[key]:homes[0]}])));
  for(const id of ['../outside','/absolute','$(touch nope)','a/b'])assert.throws(()=>validateDesiredConfiguration(desired([{...declaration(),bindingId:id}])));
  const unsafe={...declaration(),name:'<img src=x onerror=alert(1)>\u001b[31m'};await applyDesiredConfiguration(database,config,desired([unsafe]));
  const output=quiet();await selectExistingProfiles(database,config,{home:homes[0],output});assert.equal(output.text.includes('\u001b'),false);assert.deepEqual(await readdir(homes[0]),['auth.json','config.toml','sessions']);
}));

test('Agent database and runtime restart restore only the selected mapping; failed uploads retain the outbox',()=>fixture(async({database,config,homes,files})=>{
  await applyDesiredConfiguration(database,config,desired());await attachExistingHome(database,config,declaration(),homes[0]);database.close();
  const reopened=openAgentDatabase(config.databasePath);let runtime;
  try{
    runtime=new AgentRuntime(reopened,config,{fetchImpl:async()=>{throw new Error('offline');},quotaReporterFactory:entry=>({accountId:entry.accountId,async observe(){throw new Error('quota should not be requested');}})});
    await runtime.reconcile();assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[0]]);await appendFile(files[0],usage(25));await runtime.reconcile();
    const before=reopened.prepare('SELECT * FROM usage_outbox').all();await assert.rejects(runtime.sync(true,{collectQuota:false}),/unavailable/);assert.deepEqual(reopened.prepare('SELECT * FROM usage_outbox').all(),before);
    assert.equal(pendingExistingProfiles(reopened).length,0);assert.equal(before[0].total_tokens,25);
  }finally{await runtime?.stop();reopened.close();}
}));

test('Migration 009 upgrades populated deployed 008 and 006 upgrades local 005 without rewriting old migrations',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-existing-upgrade-'));
  try{for(const [kind,last] of [['server',8],['agent',5]]){
    const directory=path.join(root,kind);await mkdir(directory);const source=path.resolve('v2','migrations',kind),names=await readdir(source);
    for(const name of names.filter(n=>Number(n.slice(0,3))<=last))await copyFile(path.join(source,name),path.join(directory,name));
    const file=path.join(root,`${kind}.db`),old=new DatabaseSync(file);old.exec('PRAGMA foreign_keys=ON');migrateDatabase(old,directory);
    if(kind==='server'){
      old.exec("INSERT INTO accounts(id,name,reference,created_at,updated_at) VALUES('a','Personal',0,'t','t'); INSERT INTO devices(id,name,credential_hash,created_at,updated_at) VALUES('d','Laptop','hash','t','t'); INSERT INTO device_account_bindings(id,device_id,account_id,codex_home_key,mode,created_at) VALUES('b','d','a','default','default','t'); INSERT INTO device_profile_status(device_id,binding_id,account_id,mode,state,reported_at) VALUES('d','b','a','default','tracking','t');");
    }else old.exec("INSERT INTO profile_assignments(binding_id,account_id,name,mode,origin,local_home,active,desired_revision,applied_revision,state,created_at,updated_at) VALUES('b','a','Personal','preserve','imported','/existing/legacy',1,0,0,'tracking','t','t');");
    old.close();const upgraded=kind==='server'?openServerDatabase(file):openAgentDatabase(file);
    try{assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n,names.filter(name=>name.endsWith('.sql')).length);
      if(kind==='server'){assert.equal(upgraded.prepare("SELECT mode FROM device_account_bindings WHERE id='b'").get().mode,'default');assert.equal(upgraded.prepare("SELECT state FROM device_profile_status WHERE binding_id='b'").get().state,'tracking');}
      else{assert.equal(assignmentRows(upgraded)[0].localHome,'/existing/legacy');assert.equal(assignmentRows(upgraded)[0].origin,'imported');}
    }finally{upgraded.close();}
  }}finally{await rm(root,{recursive:true,force:true});}
});

test('Replacing the selected root with a symlink cannot redirect either collector or quota probe into Home B',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired());await attachExistingHome(database,config,declaration(),homes[0]);let probes=0;
  const runtime=new AgentRuntime(database,config,{quotaReporterFactory:entry=>({accountId:entry.accountId,async observe(){probes++;throw new Error('Must not probe the replaced root');}}),fetchImpl:async()=>new Response(JSON.stringify({acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[]}))});
  await runtime.reconcile();
  await rename(homes[0],`${homes[0]}-original`);await symlink(homes[1],homes[0],'dir');
  await assert.rejects(runtime.reconcile(),/location changed/);await runtime.sync(true);assert.equal(probes,0);assert.equal(database.prepare('SELECT error_kind FROM profile_quota_status').get().error_kind,'write_isolation_failed');await runtime.stop();
}));

test('Quota cleanup protection includes inactive and historical selections after stop/re-add across accounts',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired([declaration(),declaration('research')]));
  await attachExistingHome(database,config,declaration(),homes[0]);await attachExistingHome(database,config,declaration('research'),homes[1]);
  const sync=new AgentSyncClient(database,config);
  sync.configureProfiles([{...declaration(),localHome:homes[0]}]);
  assert.deepEqual(new Set(sync.quotaProtectedHomes),new Set(homes));
  await applyDesiredConfiguration(database,config,desired([],2));
  assert.equal(database.prepare('SELECT COUNT(*) n FROM existing_home_selections').get().n,0);
  sync.configureProfiles([]);assert.deepEqual(new Set(sync.quotaProtectedHomes),new Set(homes));
  database.prepare('DELETE FROM profile_assignments').run();
  const restarted=new AgentSyncClient(database,config);restarted.configureProfiles([]);
  assert.deepEqual(new Set(restarted.quotaProtectedHomes),new Set(homes));
}));

test('Filesystem access instrumentation records zero operations against unselected Home B during attach and tracking',()=>fixture(async({database,config,homes,files})=>{
  const originals=new Map(),touches=[];
  for(const name of ['stat','lstat','realpath','opendir','open','readFile','writeFile','appendFile','mkdir','chmod','access']){
    const original=fsPromises[name];originals.set(name,original);fsPromises[name]=async(...args)=>{const target=String(args[0]);if(target===homes[1]||target.startsWith(`${homes[1]}${path.sep}`))touches.push(name);return original(...args);};
  }
  syncBuiltinESMExports();let runtime;
  try{
    await applyDesiredConfiguration(database,config,desired());runtime=new AgentRuntime(database,config,{watchImpl:()=>({close(){}}),quotaReporterFactory:entry=>({accountId:entry.accountId,async observe(){return{accountId:entry.accountId,status:'unavailable',planType:null,errorKind:'not_authenticated',observedAt:new Date().toISOString(),windows:[]};}}),fetchImpl:async()=>new Response(JSON.stringify({acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[]}))});
    await attachExistingHome(database,config,declaration(),homes[0]);await appendFile(files[0],usage(25));await runtime.reconcile();runtime.refreshWatchers();await runtime.sync(true);assert.deepEqual(touches,[]);
  }finally{await runtime?.stop();for(const[name,fn]of originals)fsPromises[name]=fn;syncBuiltinESMExports();}
}));

test('Local selection never changes active assignments during an in-flight quota observation',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired());await attachExistingHome(database,config,declaration(),homes[0]);
  let observed,release;const started=new Promise(resolve=>observed=resolve),gate=new Promise(resolve=>release=resolve),wire=[];
  const runtime=new AgentRuntime(database,config,{quotaReporterFactory:entry=>({accountId:entry.accountId,async observe(){observed();await gate;return{accountId:entry.accountId,status:'unavailable',planType:null,errorKind:'not_authenticated',observedAt:new Date().toISOString(),windows:[]};}}),fetchImpl:async(_url,init)=>{wire.push(JSON.parse(init.body));return new Response(JSON.stringify({acceptedEventIds:[],duplicateEventIds:[],rejectedEvents:[]}));}});
  await runtime.reconcile();await runtime.applyConfiguration(desired([declaration(),declaration('research')],2));
  const syncing=runtime.sync(true);await started;
  await attachExistingHome(database,config,declaration('research'),homes[1]);
  assert.equal(assignmentRows(database).find(p=>p.accountId==='research').localHome,null);assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[0]]);
  release();await syncing;assert.deepEqual(wire[0].quotaReports.map(r=>r.accountId),['personal']);await runtime.reconcile();assert.deepEqual(runtime.collectors.map(c=>c.home).sort(),homes.slice().sort());await runtime.stop();
}));

test('A root swap before activation or remote reapply is rejected instead of silently adopting the target',()=>fixture(async({database,config,homes})=>{
  await applyDesiredConfiguration(database,config,desired());await attachExistingHome(database,config,declaration(),homes[0]);
  await rename(homes[0],`${homes[0]}-original`);await symlink(homes[1],homes[0],'dir');
  const runtime=new AgentRuntime(database,config,{syncClient:{configureProfiles(){}}});await runtime.reconcile();assert.deepEqual(runtime.collectors,[]);assert.equal(configurationState(database).status,'healthy');assert.equal(configurationState(database).profiles[0].state,'apply_failed');
  const result=await runtime.applyConfiguration(desired([{...declaration(),name:'Renamed'}],2));assert.equal(result.applied,false);assert.equal(assignmentRows(database)[0].localHome,null);await runtime.stop();
}));

test('Restart with an unavailable adopted root keeps healthy collection and remote recovery alive without redirected watchers',()=>fixture(async({database,config,homes,files})=>{
  await applyDesiredConfiguration(database,config,desired([declaration(),declaration('research')]));
  await attachExistingHome(database,config,declaration(),homes[0]);await attachExistingHome(database,config,declaration('research'),homes[1]);await activate(database,config);
  await rename(homes[0],`${homes[0]}-original`);await symlink(homes[1],homes[0],'dir');
  await appendFile(files[1],usage(25));const watched=[],bodies=[];
  const runtime=new AgentRuntime(database,config,{watchImpl:directory=>{watched.push(directory);return{close(){}};},fetchImpl:async(_url,init)=>{
    bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({acceptedEventIds:bodies.at(-1).events.map(e=>e.eventId),duplicateEventIds:[],rejectedEvents:[],serverCapabilities:SERVER_CAPABILITIES,existingHomeSelection:true,agentConfiguration:desired([declaration('research')],2)}));
  }});
  try{
    await runtime.start();assert.ok(runtime.loops.length>0);assert.ok(bodies.length>0);
    assert.deepEqual(bodies[0].events.map(e=>[e.accountId,e.totalTokens]),[['research','25']]);
    assert.equal(bodies[0].health.status,'degraded');
    assert.equal(watched.some(directory=>directory===homes[0]||directory.startsWith(`${homes[0]}${path.sep}`)),false);
    assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[1]]);
    assert.equal(configurationState(database).appliedRevision,2);
  }finally{await runtime.stop();}
}));

test('Failed same-revision local activation reports a valid profile failure and can sync, retry and recover',()=>fixture(async({database,config,homes,service})=>{
  const account=service.createAccount({name:'Personal'}),credentials=service.enroll({token:service.createDevice({name:'Laptop',accountId:account.id,mode:'existing'}).enrollmentToken},capabilities);
  const declaration=credentials.agentConfiguration.profiles[0],localConfig={...config,deviceId:credentials.deviceId,deviceSecret:credentials.deviceSecret};
  await applyDesiredConfiguration(database,localConfig,credentials.agentConfiguration);await attachExistingHome(database,localConfig,declaration,homes[0]);
  await rename(homes[0],`${homes[0]}-original`);const bodies=[];
  database.prepare("INSERT INTO agent_state(key,value,updated_at) VALUES('remote_actual_state_supported','true',?)").run(new Date(NOW).toISOString());
  const runtime=new AgentRuntime(database,localConfig,{fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body);bodies.push(body);return new Response(JSON.stringify(service.sync(service.authenticateDevice(credentials.deviceId,credentials.deviceSecret),body,capabilities)));
  }});
  try{
    await runtime.reconcile();const state=configurationState(database);
    assert.equal(state.desiredRevision,state.appliedRevision);assert.equal(state.status,'healthy');
    assert.equal(state.profiles[0].state,'apply_failed');assert.equal(state.errorKind,'profile_apply_failed');
    await runtime.sync(true,{collectQuota:false});assert.equal(bodies.length,1);
    assert.equal(service.deviceDetail(credentials.deviceId).profiles[0].trackingState,'apply_failed');
    for(const forbidden of homes)assert.equal(JSON.stringify(bodies).includes(forbidden),false);
    await rename(`${homes[0]}-original`,homes[0]);await runtime.reconcile();
    assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[0]]);assert.equal(configurationState(database).profiles[0].state,'tracking');
    assert.equal(configurationState(database).errorKind,null);
    service.disableBinding(credentials.deviceId,declaration.bindingId);await runtime.sync(true,{collectQuota:false});
    assert.deepEqual(runtime.collectors,[]);
  }finally{await runtime.stop();}
}));
