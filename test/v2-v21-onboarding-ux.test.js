import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { openAgentDatabase } from '../v2/agent/database.js';
import { AgentRuntime } from '../v2/agent/runtime.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
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
function emptyUsage(){return{measured:{...ZERO},adjusted:{totalTokens:'0'},combined:{totalTokens:'0'}};}
function unavailableQuota(){return{observedAt:null,status:'unavailable',reporterState:'no_reporter',reporterDeviceId:null,errorKind:null,planType:null,windows:[]};}
function emptyAttribution(accountId){return{accountId,quota:unavailableQuota(),windows:[],warnings:[]};}

async function domFixture({url='https://meter.example/#/overview',fetchImpl},run){
  const window=new Window({url}),document=window.document;document.body.innerHTML='<a class="skip" href="#main">Skip</a><div id="app"></div><div id="toast" hidden></div>';
  if(typeof window.HTMLDialogElement.prototype.showModal!=='function')window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  const originalDescriptors=new Map(),keys=['window','document','Node','location','navigator','fetch','confirm','setTimeout','clearTimeout'],timers=new Set(),realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
  const install=(key,value)=>{originalDescriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  install('window',window);install('document',document);install('Node',window.Node);install('location',window.location);install('navigator',window.navigator);install('fetch',fetchImpl);install('confirm',()=>true);
  install('setTimeout',(callback,delay,...args)=>{const timer=realSetTimeout(callback,delay,...args);timer.unref?.();timers.add(timer);return timer;});install('clearTimeout',timer=>{timers.delete(timer);realClearTimeout(timer);});
  const settle=async()=>{for(let index=0;index<6;index++)await new Promise(resolve=>setImmediate(resolve));};
  try{await import(`../v2/web/app.js?dom=${Date.now()}-${Math.random()}`);await settle();await run({window,document,settle});}
  finally{for(const timer of timers)realClearTimeout(timer);window.close();for(const key of keys){const descriptor=originalDescriptors.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
}

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
    document.querySelector('[data-testid="account-profile"]').value='research';document.querySelector('[data-testid="confirm-add-account"]').click();await settle();assert.deepEqual(addedBody,{accountId:'research',mode:'isolated'});assert.match(document.querySelector('[data-testid="profile-research"]').textContent,/cx2 login/);
    document.querySelector('[data-testid="stop-research"]').click();await settle();const dialog=document.querySelector('[data-testid="stop-tracking-dialog"]');assert.match(dialog.textContent,/Your Codex login and local data will not be deleted/);document.querySelector('[data-testid="confirm-stop"]').click();await settle();assert.equal(deleteCount,1);assert.match(document.querySelector('[data-testid="profile-research"]').textContent,/Not tracking/);
    document.querySelector('[data-testid="add-account"]').click();await settle();document.querySelector('[data-testid="account-profile"]').value='research';document.querySelector('[data-testid="confirm-add-account"]').click();await settle();assert.equal(addCount,2);assert.deepEqual(addedBody,{accountId:'research',mode:'isolated'});assert.match(document.querySelector('[data-testid="profile-research"]').textContent,/Login required/);
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

test('V2.1 DOM renders a stable error for a malformed successful API response',()=>domFixture({url:'https://meter.example/#/devices',fetchImpl:async input=>String(input).includes('/auth/session')?jsonResponse(200,{authenticated:true,csrfToken:'csrf'}):jsonResponse(200,{devices:{not:'an array'}})},async({document})=>{
  assert.match(document.querySelector('main').textContent,/Unexpected Server response/);
}));
