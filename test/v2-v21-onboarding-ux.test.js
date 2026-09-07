import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { openAgentDatabase } from '../v2/agent/database.js';
import { AgentRuntime } from '../v2/agent/runtime.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
import { runAgentCli } from '../v2/agent/cli.js';
import { loadConfig } from '../v2/agent/config.js';
import { openServerDatabase } from '../v2/server/database.js';
import { createV2Server } from '../v2/server/http.js';
import { MeterService } from '../v2/server/service.js';
import { AGENT_CAPABILITY_HEADER, AGENT_CAPABILITY_HEADER_VALUE, SERVER_CAPABILITIES } from '../v2/shared/capabilities.js';

const NOW=Date.parse('2026-09-04T12:00:00.000Z');
const PASSWORD='onboarding test password';
const ZERO={inputTokens:'0',cachedInputTokens:'0',cacheWriteInputTokens:'0',outputTokens:'0',reasoningOutputTokens:'0',totalTokens:'0'};

async function tempDatabases(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-onboarding-')),serverDatabase=openServerDatabase(path.join(root,'server.db')),agentDatabase=openAgentDatabase(path.join(root,'agent.db'));
  try{await run({root,serverDatabase,agentDatabase});}finally{serverDatabase.close();agentDatabase.close();await rm(root,{recursive:true,force:true});}
}

function event(eventId,occurredAt,accountId,totalTokens='1'){
  return{eventId,occurredAt,accountId,inputTokens:totalTokens,cachedInputTokens:'0',cacheWriteInputTokens:'0',outputTokens:'0',reasoningOutputTokens:'0',totalTokens,model:null,reasoningEffort:null};
}

function syncBody(events=[]){return{agentVersion:'2.1-test',codexVersion:null,events,health:{status:'healthy'}};}
function desired(revision,profiles){return{schemaVersion:1,revision,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles};}
function rolloutUsage(tokens,minute){return`${JSON.stringify({timestamp:`2026-09-04T12:${String(minute).padStart(2,'0')}:00Z`,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:tokens,input_tokens:tokens,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}}})}\n`;}

test('Existing E2E: Web Add Device → new token bootstrap → local CLI selection → Home A usage only → Server restart',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-existing-e2e-')),serverFile=path.join(root,'server.db');
  let database=openServerDatabase(serverFile);const now=Date.now();
  const server=createV2Server({database,adminPassword:PASSWORD,clock:()=>now+120000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,networkFetch=globalThis.fetch;
  let cookie,token,deviceId;const wire=[];
  const bridge=async(input,init={})=>{const url=new URL(String(input),base);const response=await networkFetch(`${base}${url.pathname}${url.search}`,{...init,headers:{...init.headers,origin:base.replace('http:','https:'),'x-forwarded-proto':'https',...(cookie?{cookie}:{})}});
    if(url.pathname.startsWith('/api/v1/agent/'))wire.push({request:init.body,response:await response.clone().json()});
    if(url.pathname==='/api/v1/devices'&&init.method==='POST'){const result=await response.clone().json();token=result.enrollmentToken;}
    return response;};
  const homes=['cx1','cx2'].map(name=>path.join(root,'home','test','.codex-profiles',name)),files=[];
  const usage=tokens=>`${JSON.stringify({timestamp:new Date(now+180000).toISOString(),type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:tokens,total_tokens:tokens}}}})}\n`;
  for(const[index,home]of homes.entries()){await mkdir(path.join(home,'sessions'),{recursive:true});const id=`11111111-1111-4111-8111-11111111111${index}`,file=path.join(home,'sessions',`rollout-${id}.jsonl`);files.push(file);await writeFile(file,`${JSON.stringify({type:'session_meta',payload:{id}})}\n${usage(100)}`);await writeFile(path.join(home,'config.toml'),'preserve = true');await writeFile(path.join(home,'auth.json'),'do not inspect');}
  let agentDatabase,runtime;
  try{
    const login=await bridge('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:PASSWORD})});cookie=login.headers.get('set-cookie').split(';')[0];const csrf=(await login.json()).csrfToken;
    const accountResponse=await bridge('/api/v1/accounts',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({name:'Personal'})}),account=await accountResponse.json();
    await domFixture({url:`${base}/#/devices/add`,fetchImpl:bridge},async({document,window,settle})=>{
      for(let i=0;i<100&&!document.querySelector('[data-testid="initial-account"]');i++){await new Promise(resolve=>setImmediate(resolve));await settle();}
      assert.equal(document.querySelectorAll('.choice-group input').length,3);
      document.querySelector('[data-testid="device-name"]').value='WSL Linux x64';document.querySelector('[data-testid="initial-account"]').value=account.id;document.querySelector('[data-testid="initial-environment-existing"]').click();
      document.querySelector('[data-testid="add-device-form"]').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
      for(let i=0;i<100&&!document.querySelector('[data-testid="command-linux"]');i++){await new Promise(resolve=>setImmediate(resolve));await settle();}
      const command=document.querySelector('[data-testid="command-linux"]').textContent;assert.ok(command.includes(token));assert.equal(command.includes('CODEX_HOME'),false);
      const configFile=path.join(root,'agent.json'),output={write(){}};
      await runAgentCli(['enroll','--server',base,'--token',token,'--config',configFile,'--allow-http-for-tests'],{stdout:output});
      const config=await loadConfig(configFile);deviceId=config.deviceId;agentDatabase=openAgentDatabase(config.databasePath);
      runtime=new AgentRuntime(agentDatabase,config,{fetchImpl:bridge,watchImpl:()=>({close(){}}),quotaReporterFactory:entry=>({accountId:entry.accountId,async observe(){return{accountId:entry.accountId,status:'unavailable',errorKind:'not_authenticated',planType:null,observedAt:new Date(now+120000).toISOString(),windows:[]};}})});
      await runtime.start();assert.equal(runtime.collectors.length,0);
      await runAgentCli(['profile','attach-existing','--config',configFile,'--codex-home',homes[0]],{stdout:output});
      await appendFile(files[0],usage(25));await runtime.reconcile();await runtime.sync(true);
      assert.deepEqual(database.prepare('SELECT account_id,total_tokens FROM usage_events').all().map(row=>[row.account_id,row.total_tokens]),[[account.id,25]]);
      await appendFile(files[1],usage(999));await runtime.reconcile();await runtime.sync(true);assert.equal(database.prepare('SELECT SUM(total_tokens) n FROM usage_events').get().n,25);
      assert.deepEqual(runtime.collectors.map(c=>c.home),[homes[0]]);
      for(const home of homes){assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),'preserve = true');assert.equal(await readFile(path.join(home,'auth.json'),'utf8'),'do not inspect');}
      for(const forbidden of [...homes,'cx1','cx2','localHome','canonical_home'])assert.equal(JSON.stringify(wire).includes(forbidden),false,forbidden);
    });
    await runtime.stop();runtime=null;await new Promise(resolve=>server.close(resolve));database.close();database=openServerDatabase(serverFile);
    const service=new MeterService(database,{adminPassword:PASSWORD,clock:()=>now+240000});assert.equal(service.deviceDetail(deviceId).profiles[0].measured.totalTokens,'25');
  }finally{await runtime?.stop();agentDatabase?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));database.close();await rm(root,{recursive:true,force:true});}
});

test('V2.1 onboarding state model and stop/re-add preserve temporal binding periods',()=>tempDatabases(async({serverDatabase})=>{
  let now=NOW;const service=new MeterService(serverDatabase,{adminPassword:PASSWORD,clock:()=>now}),enrollment=service.createDevice({name:'Laptop'}),credentials=service.enroll({token:enrollment.enrollmentToken},SERVER_CAPABILITIES),personal=service.createAccount({name:'Personal'}),binding=service.bindAccount(credentials.deviceId,{accountId:personal.id,mode:'default'});
  let profile=service.deviceDetail(credentials.deviceId).profiles[0];assert.equal(profile.trackingState,'waiting_for_agent');
  serverDatabase.prepare("UPDATE devices SET last_seen_at=?,declarative_profiles_supported=1,actual_state_supported=1,configuration_status='applying' WHERE id=?").run(new Date(now).toISOString(),credentials.deviceId);
  profile=service.deviceDetail(credentials.deviceId).profiles[0];assert.equal(profile.trackingState,'applying');
  serverDatabase.prepare("UPDATE devices SET applied_config_revision=desired_config_revision,configuration_status='healthy' WHERE id=?").run(credentials.deviceId);
  serverDatabase.prepare("INSERT INTO device_profile_status(device_id,binding_id,account_id,mode,state,reported_at) VALUES(?,?,?,?,?,?)").run(credentials.deviceId,binding.id,personal.id,'default','tracking',new Date(now).toISOString());
  profile=service.deviceDetail(credentials.deviceId).profiles[0];assert.equal(profile.trackingState,'tracking');
  serverDatabase.prepare("UPDATE device_profile_status SET state='login_required' WHERE binding_id=?").run(binding.id);assert.equal(service.deviceDetail(credentials.deviceId).profiles[0].trackingState,'login_required');
  serverDatabase.prepare("UPDATE device_profile_status SET state='quota_unavailable' WHERE binding_id=?").run(binding.id);assert.equal(service.deviceDetail(credentials.deviceId).profiles[0].trackingState,'quota_unavailable');
  const research=service.createAccount({name:'Research'});service.bindAccount(credentials.deviceId,{accountId:research.id,mode:'isolated'});serverDatabase.prepare("UPDATE devices SET configuration_status='apply_failed' WHERE id=?").run(credentials.deviceId);
  let profiles=service.deviceDetail(credentials.deviceId).profiles;assert.equal(profiles.find(item=>item.accountId===research.id).trackingState,'apply_failed');assert.equal(profiles.find(item=>item.accountId===personal.id).trackingState,'quota_unavailable');
  now+=121_000;assert.equal(service.deviceDetail(credentials.deviceId).profiles[0].trackingState,'agent_offline');
  serverDatabase.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(new Date(now).toISOString(),credentials.deviceId);
  now+=1_000;service.disableBinding(credentials.deviceId,binding.id);profile=service.deviceDetail(credentials.deviceId).profiles[0];assert.equal(profile.trackingState,'stop_tracking_pending');
  serverDatabase.prepare("UPDATE devices SET applied_config_revision=desired_config_revision,configuration_status='healthy' WHERE id=?").run(credentials.deviceId);serverDatabase.prepare('DELETE FROM device_profile_status WHERE binding_id=?').run(binding.id);assert.equal(service.deviceDetail(credentials.deviceId).profiles[0].trackingState,'stopped');
  const disabledAt=new Date(now).toISOString();now+=60_000;const resumed=service.bindAccount(credentials.deviceId,{accountId:personal.id,mode:'isolated'});assert.equal(resumed.id,binding.id);
  const periods=serverDatabase.prepare('SELECT valid_from,valid_until FROM device_account_binding_periods WHERE binding_id=? ORDER BY id').all(binding.id);assert.equal(periods.length,2);assert.equal(periods[0].valid_until,disabledAt);assert.equal(periods[1].valid_from,new Date(now).toISOString());assert.equal(periods[1].valid_until,null);
  const device=serverDatabase.prepare('SELECT * FROM devices WHERE id=?').get(credentials.deviceId),result=service.sync(device,syncBody([
    event('before-disable',new Date(NOW+500).toISOString(),personal.id),
    event('disabled-gap',new Date(NOW+150_000).toISOString(),personal.id),
    event('after-resume',new Date(now+1).toISOString(),personal.id)
  ]));
  assert.deepEqual(result.acceptedEventIds.sort(),['after-resume','before-disable']);assert.deepEqual(result.rejectedEvents,[{eventId:'disabled-gap',reason:'account_not_bound'}]);

  const legacy=service.createAccount({name:'Legacy'}),legacyBinding=service.bindAccount(credentials.deviceId,{accountId:legacy.id});now+=60_000;service.disableBinding(credentials.deviceId,legacyBinding.id);const legacyDisabledAt=now;now+=60_000;service.bindAccount(credentials.deviceId,{accountId:legacy.id,mode:'isolated'});
  const legacyResult=service.sync(serverDatabase.prepare('SELECT * FROM devices WHERE id=?').get(credentials.deviceId),syncBody([
    event('legacy-history',new Date(NOW-60_000).toISOString(),legacy.id),
    event('legacy-gap',new Date(legacyDisabledAt+30_000).toISOString(),legacy.id),
    event('legacy-resumed',new Date(now+1).toISOString(),legacy.id)
  ]));
  assert.deepEqual(legacyResult.acceptedEventIds.sort(),['legacy-history','legacy-resumed']);assert.deepEqual(legacyResult.rejectedEvents,[{eventId:'legacy-gap',reason:'account_not_bound'}]);
}));

test('V2.1 re-adding a stopped assignment baselines usage created while tracking was off',()=>tempDatabases(async({root,agentDatabase})=>{
  const home=path.join(root,'.codex'),rollout=path.join(home,'sessions','2026','09','04','rollout-11111111-1111-4111-8111-111111111111.jsonl');await mkdir(path.dirname(rollout),{recursive:true});await writeFile(rollout,`${JSON.stringify({type:'session_meta',payload:{id:'11111111-1111-4111-8111-111111111111',model:'gpt-5'}})}\n${rolloutUsage(100,0)}`);await writeFile(path.join(home,'config.toml'),'sentinel = true\n');
  let agentNow=NOW;const config={codexHome:home,databasePath:path.join(root,'agent.db'),codexExecutable:path.join(root,'codex')},runtime=new AgentRuntime(agentDatabase,config,{syncClient:{configureProfiles(){},async sync(){return{configuration:null};}},applyOptions:{clock:()=>agentNow}});
  const declaration={bindingId:'personal-binding',accountId:'personal',name:'Personal',mode:'default'};
  await runtime.applyConfiguration(desired(1,[declaration]));assert.equal(agentDatabase.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count,0);
  await appendFile(rollout,rolloutUsage(25,1));await runtime.collectors[0].reconcile();assert.deepEqual(agentDatabase.prepare('SELECT total_tokens FROM usage_outbox ORDER BY sequence').all().map(row=>row.total_tokens),[25]);
  agentNow=NOW+2*60_000;await runtime.applyConfiguration(desired(2,[]));assert.equal(runtime.collectors.length,0);await rm(rollout);
  agentNow=NOW+4*60_000;await runtime.applyConfiguration(desired(3,[declaration]));await writeFile(rollout,`${JSON.stringify({type:'session_meta',payload:{id:'11111111-1111-4111-8111-111111111111',model:'gpt-5'}})}\n${rolloutUsage(100,0)}${rolloutUsage(25,1)}${rolloutUsage(50,2)}`);await runtime.collectors[0].reconcile();assert.deepEqual(agentDatabase.prepare('SELECT total_tokens FROM usage_outbox ORDER BY sequence').all().map(row=>row.total_tokens),[25]);
  await appendFile(rollout,rolloutUsage(7,5));await runtime.collectors[0].reconcile();assert.deepEqual(agentDatabase.prepare('SELECT total_tokens FROM usage_outbox ORDER BY sequence').all().map(row=>row.total_tokens),[25,7]);assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),'sentinel = true\n');
  agentNow=NOW+6*60_000;await runtime.applyConfiguration(desired(4,[{...declaration,mode:'isolated'}]));await appendFile(rollout,rolloutUsage(40,6));agentNow=NOW+7*60_000;await runtime.applyConfiguration(desired(5,[declaration]));
  assert.deepEqual(agentDatabase.prepare('SELECT total_tokens FROM usage_outbox ORDER BY sequence').all().map(row=>row.total_tokens),[25,7]);await appendFile(rollout,rolloutUsage(9,8));await runtime.collectors[0].reconcile();assert.deepEqual(agentDatabase.prepare('SELECT total_tokens FROM usage_outbox ORDER BY sequence').all().map(row=>row.total_tokens),[25,7,9]);
}));

async function httpFixture(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-onboarding-http-')),database=openServerDatabase(path.join(root,'server.db')),server=createV2Server({database,adminPassword:PASSWORD,serverUrl:'http://127.0.0.1',clock:()=>NOW});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,secureOrigin=base.replace('http:','https:');
  const request=async(route,{method='GET',body,cookie,csrf,headers={}}={})=>{const response=await fetch(base+route,{method,headers:{'x-forwarded-proto':'https',origin:secureOrigin,...headers,...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});let value=null;try{value=await response.json();}catch{}return{response,value,cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  try{await run({root,database,server,base,request});}finally{await new Promise(resolve=>server.close(resolve));database.close();await rm(root,{recursive:true,force:true});}
}

test('V2.1 HTTP Profile and Device deletion preserve history and revoke active configuration safely',()=>httpFixture(async({database,request})=>{
  const login=await request('/api/v1/auth/login',{method:'POST',body:{password:PASSWORD}}),auth={cookie:login.cookie,csrf:login.value.csrfToken},admin=(route,options={})=>request(route,{...options,...auth});
  const account=(await admin('/api/v1/accounts',{method:'POST',body:{name:'Research'}})).value,pending=(await admin('/api/v1/devices',{method:'POST',body:{name:'Laptop',groupId:null,accountId:account.id,mode:'default'}})).value;
  const enrolled=await request('/api/v1/agent/enroll',{method:'POST',body:{token:pending.enrollmentToken},headers:{[AGENT_CAPABILITY_HEADER]:AGENT_CAPABILITY_HEADER_VALUE}}),authorization=`Bearer ${enrolled.value.deviceId}.${enrolled.value.deviceSecret}`,agentHeaders={authorization,[AGENT_CAPABILITY_HEADER]:AGENT_CAPABILITY_HEADER_VALUE};
  const synced=await request('/api/v1/agent/sync',{method:'POST',body:syncBody([event('retained',new Date(NOW).toISOString(),account.id,'25')]),headers:agentHeaders});assert.equal(synced.response.status,200);assert.deepEqual(synced.value.acceptedEventIds,['retained']);
  const before=(await admin(`/api/v1/devices/${enrolled.value.deviceId}`)).value,deleted=await admin(`/api/v1/accounts/${account.id}`,{method:'DELETE',body:{}});assert.equal(deleted.response.status,200);assert.ok(deleted.value.archivedAt);
  const after=(await admin(`/api/v1/devices/${enrolled.value.deviceId}`)).value;assert.equal(after.desiredRevision,before.desiredRevision+1);assert.deepEqual(database.prepare('SELECT account_id FROM device_configuration_revision_profiles WHERE device_id=? AND revision=?').all(enrolled.value.deviceId,after.desiredRevision),[]);
  const historical=(await admin(`/api/v1/accounts/${account.id}?range=all`)).value;assert.equal(historical.measured.totalTokens,'25');assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_events WHERE event_id=?').get('retained').count,1);
  const removed=await admin(`/api/v1/devices/${enrolled.value.deviceId}`,{method:'DELETE',body:{}});assert.deepEqual({status:removed.response.status,value:removed.value},{status:200,value:{removed:true}});assert.equal((await request('/api/v1/agent/sync',{method:'POST',body:syncBody(),headers:agentHeaders})).response.status,401);assert.equal(database.prepare('SELECT COUNT(*) count FROM usage_events WHERE event_id=?').get('retained').count,1);assert.deepEqual((await admin('/api/v1/devices')).value.devices,[]);
  const accountAfterRemoval=await admin(`/api/v1/accounts/${account.id}?range=all`);
  assert.equal(accountAfterRemoval.response.status,200);assert.deepEqual(accountAfterRemoval.value.devices,[]);
  assert.equal(accountAfterRemoval.value.measured.totalTokens,'25');
  assert.equal((await admin('/api/v1/accounts')).value.accounts.find(row=>row.id===account.id).devices,0);
}));

test('Removed laptops disappear from account device rows and counts while history and remaining devices survive restart',()=>tempDatabases(async({root,serverDatabase})=>{
  const service=new MeterService(serverDatabase,{adminPassword:PASSWORD,clock:()=>NOW});
  const account=service.createAccount({name:'Personal'}),group=service.createGroup({name:'Laptops'});
  const enroll=name=>service.enroll({token:service.createDevice({name,groupId:group.id,accountId:account.id,mode:'default'}).enrollmentToken},SERVER_CAPABILITIES);
  const removed=enroll('Old laptop'),remaining=enroll('Current laptop');
  service.sync(service.authenticateDevice(removed.deviceId,removed.deviceSecret),syncBody([event('old-laptop-history',new Date(NOW).toISOString(),account.id,'25')]));
  service.sync(service.authenticateDevice(remaining.deviceId,remaining.deviceSecret),syncBody([event('current-laptop-history',new Date(NOW).toISOString(),account.id,'7')]));
  const history=serverDatabase.prepare('SELECT * FROM usage_events ORDER BY event_id').all();
  const bindings=serverDatabase.prepare('SELECT * FROM device_account_bindings ORDER BY id').all();
  service.removeDevice(removed.deviceId);
  const verify=current=>{
    const detail=current.accountDetail(account.id),listed=current.listAccounts().find(row=>row.id===account.id);
    assert.deepEqual(detail.devices.map(row=>row.deviceId),[remaining.deviceId]);
    assert.equal(listed.devices,1);assert.equal(detail.trackingCoverage.registeredDevices,1);
    assert.equal(detail.measured.totalTokens,'32');assert.equal(detail.groups.find(row=>row.id===group.id).measured.totalTokens,'32');
    assert.equal(detail.devices[0].measured.totalTokens,'7');
    for(const device of detail.devices)assert.equal(current.deviceDetail(device.deviceId).id,device.deviceId);
    assert.equal(current.authenticateDevice(removed.deviceId,removed.deviceSecret),null);
    assert.throws(()=>current.deviceDetail(removed.deviceId),error=>error.code==='device_not_found');
  };
  verify(service);
  const reopened=openServerDatabase(path.join(root,'server.db'));
  try{
    const restarted=new MeterService(reopened,{clock:()=>NOW});verify(restarted);
    assert.deepEqual(reopened.prepare('SELECT * FROM usage_events ORDER BY event_id').all(),history);
    assert.deepEqual(reopened.prepare('SELECT * FROM device_account_bindings ORDER BY id').all(),bindings);
    // A stopped binding remains visible on a real device, but is not counted as active.
    restarted.disableBinding(remaining.deviceId,restarted.accountDetail(account.id).devices[0].id);
    assert.equal(restarted.accountDetail(account.id).devices.length,1);
    assert.equal(restarted.listAccounts().find(row=>row.id===account.id).devices,0);
    restarted.removeDevice(remaining.deviceId);
    assert.deepEqual(restarted.accountDetail(account.id).devices,[]);
    assert.equal(restarted.accountDetail(account.id).measured.totalTokens,'32');
  }finally{reopened.close();}
}));

test('Archiving a default Account stops bindings, releases the slot and preserves history without implicit reactivation',()=>tempDatabases(async({serverDatabase})=>{
  let now=NOW;const service=new MeterService(serverDatabase,{adminPassword:PASSWORD,clock:()=>now}),account=service.createAccount({name:'Old profile'});
  const credentials=service.enroll({token:service.createDevice({name:'Laptop',accountId:account.id,mode:'default'}).enrollmentToken},SERVER_CAPABILITIES);
  service.sync(service.authenticateDevice(credentials.deviceId,credentials.deviceSecret),syncBody([event('archive-history',new Date(NOW).toISOString(),account.id,'25')]));
  const before=service.deviceDetail(credentials.deviceId),binding=before.profiles[0];now+=1000;
  service.updateAccount(account.id,{archived:true});const stopped=service.desiredConfiguration(credentials.deviceId);
  assert.deepEqual(stopped.profiles,[]);assert.equal(stopped.revision,before.desiredRevision+1);
  assert.equal(service.accountDetail(account.id).trackingCoverage.registeredDevices,0);
  assert.equal(service.listAccounts().find(row=>row.id===account.id).devices,0);
  assert.equal(serverDatabase.prepare('SELECT valid_until FROM device_account_binding_periods WHERE binding_id=?').get(binding.id).valid_until,new Date(now).toISOString());
  service.sync(service.authenticateDevice(credentials.deviceId,credentials.deviceSecret),{...syncBody(),configurationState:{desiredRevision:stopped.revision,appliedRevision:stopped.revision,status:'healthy',errorKind:null,profiles:[]}},SERVER_CAPABILITIES);
  assert.equal(service.deviceDetail(credentials.deviceId).profiles[0].trackingState,'stopped');
  const replacement=service.createAccount({name:'Replacement'});service.bindAccount(credentials.deviceId,{accountId:replacement.id,mode:'default'});
  service.updateAccount(account.id,{archived:false});
  assert.deepEqual(service.desiredConfiguration(credentials.deviceId).profiles.map(row=>row.accountId),[replacement.id]);
  assert.equal(service.accountDetail(account.id).measured.totalTokens,'25');
}));

test('V2.1 Web/API add account hot-applies through a live Agent sync and reports login required',()=>httpFixture(async({root,request,base})=>{
  const login=await request('/api/v1/auth/login',{method:'POST',body:{password:PASSWORD}}),auth={cookie:login.cookie,csrf:login.value.csrfToken},admin=(route,options={})=>request(route,{...options,...auth});
  const personal=(await admin('/api/v1/accounts',{method:'POST',body:{name:'Personal'}})).value,research=(await admin('/api/v1/accounts',{method:'POST',body:{name:'Research'}})).value;
  const pending=(await admin('/api/v1/devices',{method:'POST',body:{name:'Laptop',groupId:null,accountId:personal.id,mode:'default'}})).value;
  const enrolled=await request('/api/v1/agent/enroll',{method:'POST',body:{token:pending.enrollmentToken},headers:{[AGENT_CAPABILITY_HEADER]:AGENT_CAPABILITY_HEADER_VALUE}});assert.equal(enrolled.response.status,201);
  const agentDatabase=openAgentDatabase(path.join(root,'live-agent.db')),defaultHome=path.join(root,'.codex'),launcherDirectory=path.join(root,'bin');await mkdir(defaultHome);
  const config={serverUrl:base,deviceId:enrolled.value.deviceId,deviceSecret:enrolled.value.deviceSecret,codexHome:defaultHome,databasePath:path.join(root,'live-agent.db'),codexExecutable:path.join(root,'codex'),maxBatchSize:100,allowHttpForTests:true};
  const fetchImpl=(url,options)=>fetch(url,{...options,headers:{...options.headers,'x-forwarded-proto':'https'}}),quotaReporterFactory=entry=>({accountId:entry.accountId,async observe(){return entry.accountId===research.id?{accountId:entry.accountId,observedAt:new Date(NOW).toISOString(),status:'unavailable',errorKind:'not_authenticated',planType:null,windows:[]}:{accountId:entry.accountId,observedAt:new Date(NOW).toISOString(),status:'available',planType:'plus',windows:[{limitId:'primary',durationMinutes:300,usedPercent:12,resetsAt:new Date(NOW+300*60_000).toISOString(),slot:null}]};}});
  const client=new AgentSyncClient(agentDatabase,config,{fetchImpl,clock:()=>NOW,quotaReporterFactory}),watchers=[],runtime=new AgentRuntime(agentDatabase,config,{syncClient:client,collectorFactory:entry=>({home:entry.localHome,accountId:entry.accountId,async reconcile(){}}),watchImpl:()=>{const watcher={closed:false,close(){this.closed=true;}};watchers.push(watcher);return watcher;},applyOptions:{clock:()=>NOW,baseline:async()=>{},isolatedRoot:(_config,bindingId)=>path.join(root,'profiles',bindingId),launcherDirectory,platform:'linux'}});
  try{
    runtime.running=true;await runtime.applyConfiguration(enrolled.value.agentConfiguration);await runtime.sync(true);await runtime.sync(true);
    const created=await admin(`/api/v1/devices/${enrolled.value.deviceId}/account-bindings`,{method:'POST',body:{accountId:research.id,mode:'isolated'}});assert.equal(created.response.status,201);
    await runtime.sync(true);await runtime.sync(true);
    const detail=(await admin(`/api/v1/devices/${enrolled.value.deviceId}`)).value,researchProfile=detail.profiles.find(profile=>profile.accountId===research.id),personalProfile=detail.profiles.find(profile=>profile.accountId===personal.id);
    assert.equal(detail.desiredRevision,2);assert.equal(detail.appliedRevision,2);assert.equal(detail.configurationStatus,'healthy');assert.equal(researchProfile.trackingState,'login_required');assert.match(researchProfile.actual.launcher,/^cx[1-9][0-9]*$/);
    assert.equal(personalProfile.trackingState,'tracking');assert.equal(personalProfile.actual.state,'quota_available');const coverage=(await admin(`/api/v1/accounts/${personal.id}`)).value.trackingCoverage;assert.deepEqual(coverage,{registeredDevices:1,reportingDevices:1,status:'full'});
    assert.deepEqual(runtime.collectors.map(collector=>collector.accountId).sort(),[personal.id,research.id].sort());assert.equal(client.profileQuotaReporters.length,2);
    const localAssignment=agentDatabase.prepare('SELECT local_home,launcher_name,state FROM profile_assignments WHERE account_id=? AND active=1').get(research.id);assert.equal(localAssignment.state,'login_required');assert.equal(localAssignment.launcher_name,researchProfile.actual.launcher);assert.equal((await stat(path.join(localAssignment.local_home,'.codex-meter-profile.json'))).isFile(),true);assert.match(await readFile(path.join(localAssignment.local_home,'config.toml'),'utf8'),/cli_auth_credentials_store = "file"/);
    assert.equal(JSON.stringify(detail).includes(localAssignment.local_home),false);assert.equal(JSON.stringify(detail).includes('auth.json'),false);
  }finally{runtime.running=false;for(const watcher of runtime.watchers)watcher.close();agentDatabase.close();}
}));

function jsonResponse(status,value){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

test('OpenCodex source chooser creates a Hub Profile and hides Native environment modes on enrollment',async()=>{
  const hub={id:'hub-profile',name:'Hub selected',measurementSource:'opencodex_proxy'},created=[];
  const fetchImpl=async(input,init={})=>{const route=new URL(String(input),'https://meter.example').pathname;
    if(route==='/api/v1/auth/session')return jsonResponse(200,{csrfToken:'csrf'});
    if(route==='/api/v1/groups')return jsonResponse(200,{groups:[]});
    if(route==='/api/v1/accounts'&&init.method==='POST'){created.push(JSON.parse(init.body));return jsonResponse(201,hub);}
    if(route==='/api/v1/accounts')return jsonResponse(200,{accounts:created.length?[hub]:[]});
    if(route==='/api/v1/devices'&&init.method==='POST'){created.push(JSON.parse(init.body));return jsonResponse(400,{error:'synthetic-stop-before-enrollment'});}
    return jsonResponse(404,{});
  };
  await domFixture({url:'https://meter.example/#/devices/add',fetchImpl},async({window,document,settle})=>{
    document.querySelector('[data-testid="new-profile-from-onboarding"]').click();await settle();
    const source=document.querySelector('[data-testid="measurement-source"]');assert.ok(source);source.value='opencodex_proxy';
    document.querySelector('[data-testid="profile-name"]').value=hub.name;document.querySelector('[data-testid="save-profile"]').click();await settle();
    assert.equal(created[0].measurementSource,'opencodex_proxy');assert.equal(document.querySelector('[data-testid="initial-environment-current"]').closest('fieldset').hidden,true);
    document.querySelector('[data-testid="device-name"]').value='Hub reporter';document.querySelector('[data-testid="add-device-form"]').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert.equal(created[1].mode,'opencodex');assert.equal(created[1].accountId,hub.id);assert.ok(!JSON.stringify(created).includes('logLabel'));
  });
});
test('Hub account detail renders observed ranges/coverage/quota but no Native Device/Group attribution',async()=>{
  const snap={observedAt:'2026-09-07T12:00:00.000Z',tokens:{totalTokens:'25'},coverage:0.987};
  const source={ranges:Object.fromEntries(['today','7d','30d','all'].map(r=>[r,{status:'available',lastKnownGood:snap}])),quota:{status:'available',lastKnownGood:{windows:[{limitId:'short',durationMinutes:300,usedPercent:12,resetsAt:null},{limitId:'weekly',durationMinutes:10080,usedPercent:24,resetsAt:null}]}}};
  const fetchImpl=async input=>{const route=new URL(String(input),'https://meter.example').pathname;
    if(route==='/api/v1/auth/session')return jsonResponse(200,{csrfToken:'csrf'});
    if(route==='/api/v1/accounts/hub')return jsonResponse(200,{id:'hub',name:'<img src=x onerror=alert(1)>',measurementSource:'opencodex_proxy',usageSource:source,devices:[],groups:[]});
    if(route==='/api/v1/accounts/hub/quota-attribution')return jsonResponse(200,emptyAttribution('hub'));return jsonResponse(404,{});
  };
  await domFixture({url:'https://meter.example/#/accounts/hub',fetchImpl},async({document,settle})=>{
    const panel=document.querySelector('[data-testid="hub-account-panel"]');assert.ok(panel);assert.match(panel.textContent,/98\.7%/);assert.match(panel.textContent,/5H/);assert.match(panel.textContent,/Weekly/);
    assert.match(panel.textContent,/Not attributed by device/);assert.equal(document.querySelector('main img'),null);assert.doesNotMatch(document.querySelector('main').textContent,/Group breakdown|Tracked devices|Estimated quota contribution/);
    document.querySelector('[data-testid="language-toggle"]').click();await settle();assert.match(document.querySelector('main').textContent,/OpenCodex 관측 사용량/);
  });
});
function emptyUsage(){return{measured:{...ZERO},adjusted:{totalTokens:'0'},combined:{totalTokens:'0'}};}
function unavailableQuota(){return{observedAt:null,status:'unavailable',reporterState:'no_reporter',reporterDeviceId:null,errorKind:null,planType:null,windows:[]};}
function emptyAttribution(accountId){return{accountId,quota:unavailableQuota(),windows:[],warnings:[]};}

async function domFixture({url='https://meter.example/#/overview',fetchImpl,pollTimers=null},run){
  const window=new Window({url}),document=window.document;document.body.innerHTML='<a class="skip" href="#main">Skip</a><div id="app"></div><div id="toast" hidden></div>';
  if(typeof window.HTMLDialogElement.prototype.showModal!=='function')window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  const originalDescriptors=new Map(),keys=['window','document','Node','location','navigator','fetch','confirm','setTimeout','clearTimeout'],timers=new Set(),realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
  const install=(key,value)=>{originalDescriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  install('window',window);install('document',document);install('Node',window.Node);install('location',window.location);install('navigator',window.navigator);install('fetch',fetchImpl);install('confirm',()=>true);
  install('setTimeout',(callback,delay,...args)=>{if(pollTimers&&delay===3000){const timer=Symbol('poll');pollTimers.set(timer,callback);return timer;}const timer=realSetTimeout(callback,delay,...args);timer.unref?.();timers.add(timer);return timer;});install('clearTimeout',timer=>{if(pollTimers?.delete(timer))return;timers.delete(timer);realClearTimeout(timer);});
  const settle=async()=>{for(let index=0;index<6;index++)await new Promise(resolve=>setImmediate(resolve));};
  try{await import(`../v2/web/app.js?dom=${Date.now()}-${Math.random()}`);await settle();await run({window,document,settle});}
  finally{for(const timer of timers)realClearTimeout(timer);window.close();for(const key of keys){const descriptor=originalDescriptors.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
}

test('Device polling preserves the page and drafts, retries errors, and ignores responses after navigation',async()=>{
  const pollTimers=new Map();let pendingResponse=null,failPoll=false;
  let device={id:'laptop',name:'Laptop',state:'offline',currentGroupId:null,currentGroupName:null,lastSeenAt:null,configurationStatus:'unknown',profiles:[{id:'binding',accountId:'personal',name:'Personal',mode:'default',trackingState:'waiting_for_agent',measured:{...ZERO}}]};
  const fetchImpl=async input=>{const path=new URL(String(input),'https://meter.example').pathname;
    if(path==='/api/v1/auth/session')return jsonResponse(200,{csrfToken:'csrf'});
    if(path==='/api/v1/devices/laptop'){if(pendingResponse)return pendingResponse;if(failPoll)return jsonResponse(503,{error:'unavailable'});return jsonResponse(200,device);}
    if(path==='/api/v1/usage/devices/laptop')return jsonResponse(200,emptyUsage());
    if(path==='/api/v1/groups')return jsonResponse(200,{groups:[]});
    if(path==='/api/v1/accounts')return jsonResponse(200,{accounts:[]});
    if(path==='/api/v1/devices')return jsonResponse(200,{devices:[]});
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/devices/laptop',fetchImpl,pollTimers},async({document,window,settle})=>{
    const main=document.querySelector('main'),shell=document.querySelector('.shell'),name=document.querySelector('.compact-form input'),row=document.querySelector('.profile-row');
    name.value='Unsaved laptop name';name.focus();
    const tick=async()=>{assert.equal(pollTimers.size,1);const[key,callback]=pollTimers.entries().next().value;pollTimers.delete(key);await callback();await settle();};
    await tick();assert.equal(document.querySelector('.profile-row'),row);
    assert.equal(document.querySelector('main'),main);assert.equal(document.querySelector('.shell'),shell);assert.equal(document.activeElement,name);assert.equal(name.value,'Unsaved laptop name');
    failPoll=true;await tick();assert.equal(document.querySelector('main'),main);assert.equal(name.value,'Unsaved laptop name');failPoll=false;
    device={...device,state:'online',lastSeenAt:'2026-09-05T07:00:00.000Z',profiles:device.profiles.map(profile=>({...profile,trackingState:'login_required'}))};
    await tick();assert.match(main.textContent,/Login required/);assert.equal(document.querySelector('main'),main);assert.equal(document.activeElement,name);assert.equal(name.value,'Unsaved laptop name');assert.equal(pollTimers.size,1);
    device={...device,state:'offline',profiles:device.profiles.map(profile=>({...profile,trackingState:'agent_offline'}))};
    await tick();assert.match(main.textContent,/Agent offline/);assert.equal(document.querySelector('.profile-row'),row);assert.equal(document.activeElement,name);
    await tick();assert.equal(document.querySelector('.profile-row'),row);assert.equal(document.querySelector('main'),main);
    device={...device,state:'online',profiles:device.profiles.map(profile=>({...profile,trackingState:'tracking'}))};
    await tick();assert.match(main.textContent,/Tracking/);assert.equal(document.querySelector('.profile-row'),row);assert.equal(pollTimers.size,1);
    // Re-enter the pending page, then leave while its background response is in flight.
    device.profiles[0].trackingState='applying';window.dispatchEvent(new window.HashChangeEvent('hashchange'));await settle();
    let resolveResponse;pendingResponse=new Promise(resolve=>{resolveResponse=resolve;});
    const[key,callback]=pollTimers.entries().next().value;pollTimers.delete(key);const inFlight=callback();
    window.location.hash='#/devices';window.dispatchEvent(new window.HashChangeEvent('hashchange'));await settle();const deviceList=document.querySelector('main');
    resolveResponse(jsonResponse(200,device));await inFlight;await settle();assert.equal(document.querySelector('main'),deviceList);assert.match(deviceList.textContent,/No connected devices yet/);assert.equal(pollTimers.size,0);
  });
});

test('V2.1 DOM flow signs in, creates a current-login Device, and renders safe enrollment commands',async()=>{
  let authenticated=false,createdBody=null;const account={id:'personal',name:"Personal '; rm -rf",archivedAt:null,reference:false,devices:0,measured:{...ZERO},quota:unavailableQuota(),trackingCoverage:{registeredDevices:0,reportingDevices:0,status:'unknown'}};
  const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return authenticated?jsonResponse(200,{authenticated:true,csrfToken:'csrf'}):jsonResponse(401,{error:'unauthorized'});
    if(route==='/api/v1/auth/login'&&method==='POST'){authenticated=true;return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});}
    if(route==='/api/v1/accounts?range=all')return jsonResponse(200,{accounts:[account]});
    if(route==='/api/v1/usage/summary?range=today')return jsonResponse(200,{...emptyUsage(),groups:[]});
    if(route==='/api/v1/accounts/personal/quota-attribution')return jsonResponse(200,emptyAttribution('personal'));
    if(route==='/api/v1/devices'&&method==='GET')return jsonResponse(200,{devices:[]});
    if(route==='/api/v1/groups')return jsonResponse(200,{groups:[]});
    if(route==='/api/v1/devices'&&method==='POST'){createdBody=JSON.parse(options.body);return jsonResponse(201,{enrollmentId:'enroll-1',enrollmentToken:'a'.repeat(32),expiresAt:'2026-09-04T12:15:00.000Z'});}
    if(route==='/api/v1/device-enrollments/enroll-1')return jsonResponse(200,{status:'pending',deviceId:null});
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({fetchImpl},async({window,document,settle})=>{
    const password=document.querySelector('input[type="password"]');assert.ok(password);password.value='test password';document.querySelector('.login form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
    const devicesLink=[...document.querySelectorAll('a')].find(link=>link.textContent==='Devices');devicesLink.click();window.location.hash='#/devices';window.dispatchEvent(new window.HashChangeEvent('hashchange'));await settle();
    const addLink=[...document.querySelectorAll('a')].find(link=>link.textContent==='Add device');addLink.click();window.location.hash='#/devices/add';window.dispatchEvent(new window.HashChangeEvent('hashchange'));await settle();
    document.querySelector('[data-testid="device-name"]').value='Laptop; $(touch unsafe)';document.querySelector('[data-testid="initial-account"]').value='personal';assert.equal(document.querySelector('[data-testid="initial-environment-current"]').checked,true);
    document.querySelector('[data-testid="add-device-form"]').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert.deepEqual(createdBody,{name:'Laptop; $(touch unsafe)',groupId:null,accountId:'personal',mode:'default'});
    const commands=[...document.querySelectorAll('.code-line code')].map(node=>node.textContent);assert.equal(commands.length,3);for(const command of commands){assert.equal(command.includes('Laptop'),false);assert.equal(command.includes(account.name),false);assert.equal(command.includes('a'.repeat(32)),true);}assert.match(document.body.textContent,/Waiting for the Agent to connect/);
  });
});

test('V2.1 DOM Device onboarding creates and selects its first Account Profile inline',async()=>{
  let accounts=[],createdBody=null;const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route==='/api/v1/groups')return jsonResponse(200,{groups:[{id:'group-1',name:'Development',archivedAt:null}]});
    if(route==='/api/v1/accounts?range=all')return jsonResponse(200,{accounts});
    if(route==='/api/v1/accounts'&&method==='POST'){createdBody=JSON.parse(options.body);const created={id:'personal',name:createdBody.name,reference:false,archivedAt:null};accounts=[created];return jsonResponse(201,created);}
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/devices/add',fetchImpl},async({document,settle})=>{
    document.querySelector('[data-testid="device-name"]').value='Laptop';document.querySelector('[data-testid="initial-environment-separate"]').click();document.querySelector('[data-testid="new-profile-from-onboarding"]').click();document.querySelector('[data-testid="profile-name"]').value='Personal';document.querySelector('[data-testid="save-profile"]').click();await settle();
    assert.deepEqual(createdBody,{name:'Personal',reference:false});assert.equal(document.querySelector('[data-testid="device-name"]').value,'Laptop');assert.equal(document.querySelector('[data-testid="initial-account"]').value,'personal');assert.equal(document.querySelector('[data-testid="initial-environment-separate"]').checked,true);assert.equal(document.querySelector('[data-testid="add-device-form"] [type="submit"]').disabled,false);
  });
});

test('V2.1 DOM Accounts flow creates a new Account Profile from the New profile button',async()=>{
  const accounts=[];let createdBody=null;const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route.startsWith('/api/v1/accounts?range='))return jsonResponse(200,{accounts:accounts.map(account=>({...account,devices:0,measured:{...ZERO},quota:unavailableQuota(),trackingCoverage:{registeredDevices:0,reportingDevices:0,status:'unknown'}}))});
    if(route==='/api/v1/accounts'&&method==='POST'){createdBody=JSON.parse(options.body);const account={id:'research',name:createdBody.name,reference:createdBody.reference,archivedAt:null};accounts.push(account);return jsonResponse(201,account);}
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/accounts',fetchImpl},async({document,settle})=>{
    const create=document.querySelector('[data-testid="new-profile"]');assert.ok(create);assert.equal(create.disabled,false);create.click();
    const dialog=document.querySelector('[data-testid="account-profile-dialog"]');assert.ok(dialog);document.querySelector('[data-testid="profile-name"]').value='Research <script>';
    document.querySelector('[data-testid="save-profile"]').click();await settle();assert.deepEqual(createdBody,{name:'Research <script>',reference:false});assert.equal(document.querySelector('[data-testid="account-profile-dialog"]'),null);assert.match(document.querySelector('main').textContent,/Research <script>/);assert.equal(document.querySelector('main script'),null);
  });
});

test('V2.1 DOM language toggle switches English and Korean, persists the choice, and preserves user labels',async()=>{
  const account={id:'devices',name:'Devices <script>',archivedAt:null,reference:false,devices:0,measured:{...ZERO},quota:unavailableQuota(),trackingCoverage:{registeredDevices:0,reportingDevices:0,status:'unknown'}};
  const fetchImpl=async(input)=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search;
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route.startsWith('/api/v1/accounts?range='))return jsonResponse(200,{accounts:[account]});
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/accounts',fetchImpl},async({document,window,settle})=>{
    assert.equal(document.documentElement.lang,'en');assert.match(document.querySelector('main').textContent,/Account Profiles and tracking coverage/);assert.match(document.querySelector('main').textContent,/Devices <script>/);
    document.querySelector('[data-testid="language-toggle"]').click();await settle();assert.equal(document.documentElement.lang,'ko');assert.match(document.cookie,/codex_meter_language=ko/);assert.match(document.querySelector('main').textContent,/계정 프로필과 추적 범위/);assert.match(document.querySelector('main').textContent,/Devices <script>/);assert.equal(document.querySelector('main script'),null);
    document.querySelector('[data-testid="delete-account-devices"]').click();assert.match(document.querySelector('[data-testid="delete-account-dialog"]').textContent,/과거 사용 기록과 로컬 Codex 로그인 데이터는 유지됩니다/);document.querySelector('[data-testid="delete-account-dialog"] button:not(.danger)').click();
    document.querySelector('[data-testid="language-toggle"]').click();await settle();assert.equal(document.documentElement.lang,'en');assert.match(document.cookie,/codex_meter_language=en/);assert.match(document.querySelector('main').textContent,/Account Profiles and tracking coverage/);
  });
});

test('V2.1 DOM Accounts flow deletes a Profile while explaining history and local data retention',async()=>{
  const profile=(archivedAt=null)=>({id:'research',name:'Research <script>',archivedAt,reference:false,devices:1,measured:{...ZERO,totalTokens:'25'},quota:unavailableQuota(),trackingCoverage:{registeredDevices:1,reportingDevices:1,status:'full'}});let accounts=[profile()],deleteCount=0;
  const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route.startsWith('/api/v1/accounts?range='))return jsonResponse(200,{accounts});
    if(route==='/api/v1/accounts/research'&&method==='DELETE'){deleteCount+=1;accounts=[profile('2026-09-04T12:00:00.000Z')];return jsonResponse(200,accounts[0]);}
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/accounts',fetchImpl},async({document,settle})=>{
    assert.ok(document.querySelector('[data-testid="account-research"]'));document.querySelector('[data-testid="delete-account-research"]').click();
    const dialog=document.querySelector('[data-testid="delete-account-dialog"]');assert.ok(dialog);assert.match(dialog.textContent,/stop tracking this Profile on every Device/);assert.match(dialog.textContent,/Historical usage and local Codex login data remain/);assert.equal(dialog.querySelector('script'),null);
    document.querySelector('[data-testid="confirm-delete-account-dialog"]').click();await settle();assert.equal(deleteCount,1);assert.equal(document.querySelector('[data-testid="account-research"]'),null);assert.match(document.querySelector('main').textContent,/No Account Profiles yet/);
  });
});

test('V2.1 DOM Devices flow removes a Device from the list with an explicit retention warning',async()=>{
  const laptop={id:'device-1',name:'Laptop <script>',currentGroupName:'Development',state:'online',lastSeenAt:'2026-09-04T12:00:00.000Z'};let devicesList=[laptop],deleteCount=0;
  const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route==='/api/v1/devices'&&method==='GET')return jsonResponse(200,{devices:devicesList});
    if(route==='/api/v1/devices/device-1'&&method==='DELETE'){deleteCount+=1;devicesList=[];return jsonResponse(200,{removed:true});}
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/devices',fetchImpl},async({document,settle})=>{
    document.querySelector('[data-testid="remove-device-device-1"]').click();const dialog=document.querySelector('[data-testid="remove-device-dialog"]');assert.ok(dialog);assert.match(dialog.textContent,/revoke this Device credential/);assert.match(dialog.textContent,/local Agent and Codex data are not deleted/);assert.equal(dialog.querySelector('script'),null);
    document.querySelector('[data-testid="confirm-remove-device-dialog"]').click();await settle();assert.equal(deleteCount,1);assert.match(document.querySelector('main').textContent,/No connected devices yet/);
  });
});

test('V2.1 DOM Device flow creates and selects a Profile when no unbound Profile exists',async()=>{
  const personal={id:'personal',name:'Personal',archivedAt:null,trackingCoverage:{registeredDevices:1,reportingDevices:1,status:'full'},measured:{...ZERO},quota:unavailableQuota()};let accounts=[personal],createdBody=null,addedBody=null;
  const profile={id:'personal-binding',accountId:'personal',name:'Personal',mode:'isolated',disabledAt:null,reference:false,measured:{...ZERO},trackingState:'tracking',lastActivityAt:null,actual:{state:'tracking',launcher:'cx1',reportedAt:'2026-09-04T12:00:00.000Z'}};
  const device={id:'device-1',name:'Laptop',currentGroupId:null,currentGroupName:null,disabledAt:null,lastSeenAt:'2026-09-04T12:00:00.000Z',state:'online',configurationStatus:'healthy',desiredRevision:1,appliedRevision:1,profiles:[profile]};
  const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route==='/api/v1/devices/device-1')return jsonResponse(200,device);
    if(route==='/api/v1/usage/devices/device-1?range=today')return jsonResponse(200,emptyUsage());
    if(route==='/api/v1/groups')return jsonResponse(200,{groups:[]});
    if(route==='/api/v1/accounts?range=all')return jsonResponse(200,{accounts});
    if(route==='/api/v1/accounts'&&method==='POST'){createdBody=JSON.parse(options.body);const created={id:'research',name:createdBody.name,reference:false,archivedAt:null};accounts=[...accounts,created];return jsonResponse(201,created);}
    if(route==='/api/v1/devices/device-1/account-bindings'&&method==='POST'){addedBody=JSON.parse(options.body);return jsonResponse(201,{id:'research-binding'});}
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/devices/device-1',fetchImpl},async({document,settle})=>{
    const add=document.querySelector('[data-testid="add-account"]');assert.equal(add.disabled,false);add.click();assert.equal(document.querySelector('[data-testid="confirm-add-account"]').disabled,true);
    document.querySelector('[data-testid="account-environment-separate"]').click();document.querySelector('[data-testid="new-profile-from-device"]').click();assert.ok(document.querySelector('[data-testid="account-profile-dialog"]'));document.querySelector('[data-testid="profile-name"]').value='Research';document.querySelector('[data-testid="save-profile"]').click();await settle();
    assert.deepEqual(createdBody,{name:'Research',reference:false});assert.equal(document.querySelector('[data-testid="account-profile"]').value,'research');assert.equal(document.querySelector('[data-testid="account-environment-separate"]').checked,true);assert.equal(document.querySelector('[data-testid="confirm-add-account"]').disabled,false);
    document.querySelector('[data-testid="confirm-add-account"]').click();await settle();assert.deepEqual(addedBody,{accountId:'research',mode:'isolated'});
  });
});

test('V2.1 DOM Profile save blocks Cancel and Escape while its request is pending',async()=>{
  const personal={id:'personal',name:'Personal',archivedAt:null,trackingCoverage:{registeredDevices:1,reportingDevices:1,status:'full'},measured:{...ZERO},quota:unavailableQuota()},device={id:'device-1',name:'Laptop',currentGroupId:null,currentGroupName:null,disabledAt:null,lastSeenAt:'2026-09-04T12:00:00.000Z',state:'online',configurationStatus:'healthy',desiredRevision:1,appliedRevision:1,profiles:[{id:'personal-binding',accountId:'personal',name:'Personal',mode:'default',disabledAt:null,reference:false,measured:{...ZERO},trackingState:'tracking',lastActivityAt:null,actual:{state:'tracking',launcher:null,reportedAt:'2026-09-04T12:00:00.000Z'}}]};let resolveCreate;
  const pendingCreate=new Promise(resolve=>{resolveCreate=resolve;});const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route==='/api/v1/devices/device-1')return jsonResponse(200,device);
    if(route==='/api/v1/usage/devices/device-1?range=today')return jsonResponse(200,emptyUsage());
    if(route==='/api/v1/groups')return jsonResponse(200,{groups:[]});
    if(route==='/api/v1/accounts?range=all')return jsonResponse(200,{accounts:[personal]});
    if(route==='/api/v1/accounts'&&method==='POST')return pendingCreate;
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/devices/device-1',fetchImpl},async({window,document,settle})=>{
    document.querySelector('[data-testid="add-account"]').click();document.querySelector('[data-testid="new-profile-from-device"]').click();document.querySelector('[data-testid="profile-name"]').value='Research';document.querySelector('[data-testid="save-profile"]').click();await settle();
    const dialog=document.querySelector('[data-testid="account-profile-dialog"]'),cancel=document.querySelector('[data-testid="cancel-profile"]');assert.equal(cancel.disabled,true);const cancelEvent=new window.Event('cancel',{cancelable:true});dialog.dispatchEvent(cancelEvent);assert.equal(cancelEvent.defaultPrevented,true);assert.equal(document.querySelectorAll('dialog').length,1);
    resolveCreate(jsonResponse(201,{id:'research',name:'Research',reference:false,archivedAt:null}));await settle();assert.equal(document.querySelectorAll('[data-testid="account-profile-dialog"]').length,0);assert.equal(document.querySelectorAll('[data-testid="add-account-dialog"]').length,1);assert.equal(document.querySelector('[data-testid="account-profile"]').value,'research');
  });
});

test('V2.1 DOM Device flow adds, stops, and re-adds a separate login',async()=>{
  let added=false,stopped=false,addedBody=null,addCount=0,deleteCount=0;const accounts=[{id:'personal',name:'Personal',archivedAt:null,trackingCoverage:{registeredDevices:1,reportingDevices:1,status:'full'},measured:{...ZERO},quota:unavailableQuota()},{id:'research',name:'Research',archivedAt:null,trackingCoverage:{registeredDevices:0,reportingDevices:0,status:'unknown'},measured:{...ZERO},quota:unavailableQuota()}];
  const profile=(accountId,name,mode,state,launcher=null,disabledAt=null)=>({id:`${accountId}-binding`,accountId,name,mode,disabledAt,reference:false,measured:{...ZERO},trackingState:state,lastActivityAt:null,actual:state==='waiting_for_agent'?null:{state:state==='login_required'?'login_required':'tracking',launcher,reportedAt:'2026-09-04T12:00:00.000Z'}});
  const device=()=>({id:'device-1',name:'Laptop',currentGroupId:null,currentGroupName:null,disabledAt:null,lastSeenAt:'2026-09-04T12:00:00.000Z',state:'online',configurationStatus:'healthy',desiredRevision:added?2:1,appliedRevision:added?2:1,profiles:[profile('personal','Personal','default','tracking'),...(added?[profile('research','Research','isolated',stopped?'stopped':'login_required','cx2',stopped?'2026-09-04T12:01:00.000Z':null)]:[])]});
  const fetchImpl=async(input,options={})=>{const target=new URL(String(input),'https://meter.example'),route=target.pathname+target.search,method=options.method??'GET';
    if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});
    if(route==='/api/v1/devices/device-1')return jsonResponse(200,device());
    if(route==='/api/v1/usage/devices/device-1?range=today')return jsonResponse(200,emptyUsage());
    if(route==='/api/v1/groups')return jsonResponse(200,{groups:[]});
    if(route==='/api/v1/accounts?range=all')return jsonResponse(200,{accounts});
    if(route==='/api/v1/devices/device-1/account-bindings'&&method==='POST'){addedBody=JSON.parse(options.body);added=true;stopped=false;addCount+=1;return jsonResponse(201,{id:'research-binding'});}
    if(route==='/api/v1/devices/device-1/account-bindings/research-binding'&&method==='DELETE'){deleteCount+=1;stopped=true;return jsonResponse(200,{id:'research-binding',disabledAt:'2026-09-04T12:01:00.000Z'});}
    return jsonResponse(404,{error:'not_found'});
  };
  await domFixture({url:'https://meter.example/#/devices/device-1',fetchImpl},async({document,settle})=>{
    document.querySelector('[data-testid="add-account"]').click();await settle();assert.ok(document.querySelector('[data-testid="add-account-dialog"]'));assert.equal(document.querySelector('[data-testid="account-environment-current"]').disabled,true);assert.equal(document.querySelector('[data-testid="account-environment-separate"]').checked,true);
    document.querySelector('[data-testid="account-profile"]').value='research';document.querySelector('[data-testid="account-profile"]').dispatchEvent(new document.defaultView.Event('change',{bubbles:true}));document.querySelector('[data-testid="confirm-add-account"]').click();await settle();assert.deepEqual(addedBody,{accountId:'research',mode:'isolated'});
    assert.deepEqual([...document.querySelectorAll('[data-testid="profile-research"] .login-command code')].map(node=>node.textContent),['"$HOME/.local/bin/cx2" login','"$HOME/Library/Application Support/Codex Meter/cx2" login','& "$env:LOCALAPPDATA\\CodexMeter\\cx2.ps1" login']);
    document.querySelector('[data-testid="stop-research"]').click();await settle();const dialog=document.querySelector('[data-testid="stop-tracking-dialog"]');assert.match(dialog.textContent,/Your Codex login and local data will not be deleted/);document.querySelector('[data-testid="confirm-stop"]').click();await settle();assert.equal(deleteCount,1);assert.match(document.querySelector('[data-testid="profile-research"]').textContent,/Not tracking/);
    document.querySelector('[data-testid="add-account"]').click();await settle();document.querySelector('[data-testid="account-profile"]').value='research';document.querySelector('[data-testid="account-profile"]').dispatchEvent(new document.defaultView.Event('change',{bubbles:true}));document.querySelector('[data-testid="confirm-add-account"]').click();await settle();assert.equal(addCount,2);assert.deepEqual(addedBody,{accountId:'research',mode:'isolated'});assert.match(document.querySelector('[data-testid="profile-research"]').textContent,/Login required/);
  });
});

test('V2.1 DOM Account detail shows registered-device coverage and estimated quota contribution',async()=>{
  const account={id:'personal',name:'Personal',archivedAt:null,reference:false,measured:{...ZERO,totalTokens:'100'},quota:unavailableQuota(),trackingCoverage:{registeredDevices:3,reportingDevices:2,status:'partial'},devices:[
    {deviceId:'laptop',name:'Laptop',mode:'default',trackingState:'tracking',lastActivityAt:'2026-09-04T11:59:00.000Z',measured:{...ZERO,totalTokens:'70'}},
    {deviceId:'desktop',name:'Desktop',mode:'isolated',trackingState:'agent_offline',lastActivityAt:'2026-09-04T10:00:00.000Z',measured:{...ZERO,totalTokens:'30'}},
    {deviceId:'legacy',name:'Legacy',mode:'preserve',trackingState:'tracking',lastActivityAt:null,measured:{...ZERO}}
  ],groups:[],unassigned:{...ZERO}};
  const attribution={accountId:'personal',quota:{observedAt:'2026-09-04T12:00:00.000Z',status:'available',reporterState:'available',reporterDeviceId:'laptop',errorKind:null,planType:'plus'},windows:[{limitId:'primary',durationMinutes:300,slot:null,usedPercent:42,resetsAt:'2026-09-04T15:00:00.000Z',cycleStart:'2026-09-04T10:00:00.000Z',coverage:{status:'partial',from:'2026-09-04T11:00:00.000Z',baselineUsedPercent:30},estimate:{status:'available',basisPercentagePoints:12,semantics:'since_tracking_began',basedOnObservedAt:'2026-09-04T12:00:00.000Z',reason:null},tracked:{from:'2026-09-04T11:00:00.000Z',to:'2026-09-04T12:00:00.000Z',totalTokens:'100'},groups:[{group:null,label:'Unassigned',trackedTokens:'100',trackedSharePercent:100,estimatedQuotaContributionPercentagePoints:12}]}],warnings:['estimated_not_provider_attributed']};
  const fetchImpl=async input=>{const route=new URL(String(input),'https://meter.example').pathname+new URL(String(input),'https://meter.example').search;if(route==='/api/v1/auth/session')return jsonResponse(200,{authenticated:true,csrfToken:'csrf'});if(route==='/api/v1/accounts/personal?range=today')return jsonResponse(200,account);if(route==='/api/v1/accounts/personal/quota-attribution')return jsonResponse(200,attribution);return jsonResponse(404,{error:'not_found'});};
  await domFixture({url:'https://meter.example/#/accounts/personal',fetchImpl},async({document})=>{
    const text=document.querySelector('main').textContent;assert.match(text,/2 \/ 3 registered devices reporting - estimate may be incomplete/);assert.match(text,/42% used/);assert.match(text,/Estimated quota contribution since tracking began/);assert.match(text,/~12.0%p/);assert.match(text,/Existing Codex login/);assert.match(text,/Agent offline/);
  });
});

test('Existing Web statuses and Korean option explain local selection and original launcher without UUIDs or XSS',async()=>{
  const pollTimers=new Map(),profile={id:'hidden-binding',accountId:'personal',name:'<img src=x onerror=alert(1)>',mode:'existing',trackingState:'local_selection_required',measured:{...ZERO},actual:{state:'local_selection_required'}};
  const fetchImpl=async input=>{const route=new URL(String(input),'https://meter.example').pathname;
    if(route==='/api/v1/auth/session')return jsonResponse(200,{csrfToken:'csrf'});
    if(route==='/api/v1/devices/laptop')return jsonResponse(200,{id:'laptop',name:'Laptop',profiles:[profile],state:'online'});
    if(route==='/api/v1/usage/devices/laptop')return jsonResponse(200,emptyUsage());
    if(route==='/api/v1/groups')return jsonResponse(200,{groups:[]});
    if(route==='/api/v1/accounts')return jsonResponse(200,{accounts:[]});return jsonResponse(404,{});};
  await domFixture({url:'https://meter.example/#/devices/laptop',fetchImpl,pollTimers},async({document,settle})=>{
    let row=document.querySelector('.profile-row');assert.match(row.textContent,/Waiting for local environment selection/);assert.match(row.textContent,/codex-meter-agent profile attach-existing/);assert.doesNotMatch(row.textContent,/hidden-binding/);assert.equal(row.querySelector('img'),null);
    profile.trackingState='login_required';profile.actual.state='login_required';const[key,callback]=pollTimers.entries().next().value;pollTimers.delete(key);await callback();await settle();
    row=document.querySelector('.profile-row');assert.match(row.textContent,/Use your existing Codex launcher to sign in/);assert.equal(row.querySelector('.login-command'),null);
    document.querySelector('[data-testid="language-toggle"]').click();await settle();assert.match(document.querySelector('main').textContent,/평소 사용하는 Codex 실행 명령으로 로그인/);
  });
});

test('Overview distinguishes two Weekly provider buckets without discarding the 5H window',async()=>{
  const account={id:'personal',name:'Personal',trackingCoverage:{status:'full',registeredDevices:1,reportingDevices:1}};
  const windows=[['codex',10080],['codex_bengalfox',300],['codex_bengalfox',10080]].map(([limitId,durationMinutes])=>({limitId,durationMinutes,usedPercent:12,resetsAt:new Date(Date.now()+600000).toISOString(),coverage:{status:'full'},estimate:{status:'available'},groups:[]}));
  const fetchImpl=async input=>{const route=new URL(String(input),'https://meter.example').pathname;
    if(route==='/api/v1/auth/session')return jsonResponse(200,{csrfToken:'csrf'});
    if(route==='/api/v1/accounts')return jsonResponse(200,{accounts:[account]});
    if(route==='/api/v1/accounts/personal/quota-attribution')return jsonResponse(200,{accountId:'personal',quota:{status:'available',reporterState:'available'},windows});
    if(route==='/api/v1/usage/summary')return jsonResponse(200,{groups:[]});return jsonResponse(404,{});};
  await domFixture({fetchImpl},async({document,settle})=>{
    const tabs=()=>[...document.querySelectorAll('[aria-label="Provider quota window"] button')];assert.deepEqual(tabs().map(node=>node.textContent),['codex · Weekly','codex_bengalfox · 5H','codex_bengalfox · Weekly']);
    assert.match(document.querySelector('main').textContent,/not a separate local usage counter/);tabs()[2].click();await settle();assert.match(document.querySelector('.cycle-summary h2').textContent,/codex_bengalfox · Weekly/);assert.equal(tabs()[2].getAttribute('aria-pressed'),'true');
  });
});

test('V2.1 DOM renders a stable error for a malformed successful API response',()=>domFixture({url:'https://meter.example/#/devices',fetchImpl:async input=>String(input).includes('/auth/session')?jsonResponse(200,{authenticated:true,csrfToken:'csrf'}):jsonResponse(200,{devices:{not:'an array'}})},async({document})=>{
  assert.match(document.querySelector('main').textContent,/Unexpected Server response/);
}));
