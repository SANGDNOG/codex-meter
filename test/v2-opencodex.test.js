import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, chmod, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openAgentDatabase } from '../v2/agent/database.js';
import { openServerDatabase } from '../v2/server/database.js';
import { MeterService } from '../v2/server/service.js';
import { createV2Server } from '../v2/server/http.js';
import { SERVER_CAPABILITIES, AGENT_CAPABILITY_HEADER_VALUE } from '../v2/shared/capabilities.js';
import { HUB_RANGES, HUB_COUNTS, HUB_TOKENS, validateHubUsage, validateHubQuota } from '../v2/shared/hub-snapshot.js';
import { OpenCodexClient, connectHub, attachOpenCodex, HubAdapter, parseHubAccounts, parseHubUsage, parseHubQuota, meterHubRequest, validateHubDesired } from '../v2/agent/opencodex.js';
import { applyDesiredConfiguration } from '../v2/agent/assignments.js';
import { AgentRuntime } from '../v2/agent/runtime.js';
import { selectExistingProfiles } from '../v2/agent/attach-existing.js';

const NOW=Date.parse('2026-09-07T12:00:00Z'),caps={...SERVER_CAPABILITIES,existingHomeSelection:true,opencodexHub:true};
const TOKEN='hub-private-fixture-credential',A='p111aaa',B='p222bbb',C='p333ccc';
const quiet=()=>({text:'',write(value){this.text+=value;}});
const pool=(label,quota=50)=>({id:`raw-id-${label}`,logLabel:label,isMain:label==='main',alias:`Alias ${label}`,email:`${label}@private.example`,plan:'pro',quota:{updatedAt:NOW,weeklyPercent:quota,weeklyResetAt:NOW+86400000,shortPercent:12,shortWindowSeconds:18000,shortResetAt:NOW+3600000}});
const usageRow=(label,tokens)=>({accountLogLabel:label,ambiguous:false,...Object.fromEntries(HUB_TOKENS.map(k=>[k,k==='totalTokens'||k==='inputTokens'?tokens:0])),...Object.fromEntries(HUB_COUNTS.map(k=>[k,['requests','attemptCount','measuredAttempts','reportedAttempts'].includes(k)?1:0])),usageCoverageRatio:0.987});
const rawUsage=(range,accounts=[usageRow(A,999),usageRow(B,25),usageRow(C,888)],generatedAt=NOW)=>({range,surface:'codex',since:range==='all'?null:NOW-86400000,generatedAt,accounts,historyTruncated:false,entriesTruncated:false});
async function fixture(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'meter-hub-test-'));
  const db=openAgentDatabase(path.join(root,'agent.db')),serverDb=openServerDatabase(path.join(root,'server.db'));
  let now=NOW;const service=new MeterService(serverDb,{adminPassword:'fixture password only',clock:()=>now});
  const account=service.createAccount({name:'Selected Meter Profile',measurementSource:'opencodex_proxy'}),group=service.createGroup({name:'Reporter Group'});
  const enrollment=service.createDevice({name:'Hub reporter',accountId:account.id,groupId:group.id,mode:'opencodex'});
  const enrolled=service.enroll({token:enrollment.enrollmentToken},caps);
  const config={databasePath:path.join(root,'agent.db'),serverUrl:'https://meter.example',deviceId:enrolled.deviceId,deviceSecret:enrolled.deviceSecret,codexHome:path.join(root,'NEVER-READ-NATIVE-HOME'),profiles:[],maxBatchSize:100};
  await applyDesiredConfiguration(db,config,enrolled.agentConfiguration);
  const calls=[],reports=[];let accounts=[pool(A),pool(B),pool(C)],usageTransform=x=>x,accountStatus=200,accountTransform=x=>x;
  const fetchImpl=async(url,init={})=>{
    const parsed=new URL(url);calls.push({host:parsed.host,path:parsed.pathname,search:parsed.search});
    if(parsed.host==='meter.example'){
      assert.equal(init.headers.authorization,`Bearer ${config.deviceId}.${config.deviceSecret}`);
      const device=service.authenticateDevice(config.deviceId,config.deviceSecret);if(!device)return new Response('{}',{status:401});
      if(parsed.pathname==='/api/v1/agent/sync')return Response.json(service.sync(device,JSON.parse(init.body),caps));
      if(init.method==='POST'){const body=JSON.parse(init.body);reports.push(body);try{return Response.json(service.hub.report(device,body));}catch(e){return Response.json({error:e.code},{status:e.status});}}
      return Response.json(service.hub.desired(device));
    }
    assert.equal(parsed.origin,'https://hub.example');assert.equal(init.headers.authorization,`Bearer ${TOKEN}`);assert.equal(init.redirect,'error');
    if(parsed.pathname==='/api/codex-auth/accounts')return Response.json(accountTransform({accounts}),{status:accountStatus});
    assert.equal(parsed.pathname,'/api/usage');return Response.json(usageTransform(rawUsage(parsed.searchParams.get('range'),undefined,now)));
  };
  const secretFile=path.join(root,'credential');await writeFile(secretFile,TOKEN,{mode:0o600});
  const connect=()=>connectHub(db,config,{url:'https://hub.example',secretFile,fetchImpl});
  const attach=async(answer='2',extras={})=>{const output=quiet();await attachOpenCodex(db,config,{fetchImpl,output,question:async()=>answer,...extras});return output;};
  try{await run({root,db,serverDb,service,account,group,config,enrolled,fetchImpl,calls,reports,connect,attach,secretFile,clock:()=>now,advance:ms=>now+=ms,setAccounts:value=>accounts=value,setAccountStatus:value=>accountStatus=value,setAccountTransform:value=>accountTransform=value,setUsage:value=>usageTransform=value});}
  finally{if(db.isOpen)db.close();serverDb.close();await rm(root,{recursive:true,force:true});}
}

test('Hub connect validates stock API; credential reference only, private connection, no DB secret',()=>fixture(async c=>{
  await c.connect();const saved=JSON.parse(await readFile(path.join(c.root,'hub-connection.json'),'utf8'));
  assert.equal(saved.credential.path,c.secretFile);assert.ok(!JSON.stringify(saved).includes(TOKEN));assert.equal((await stat(path.join(c.root,'hub-connection.json'))).mode&0o777,0o600);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM hub_selections').get().n,0);
}));
for(const status of [401,403,503])test(`Hub connection rejects HTTP ${status} without persistence or secret diagnostics`,()=>fixture(async c=>{
  c.setAccountStatus(status);await assert.rejects(c.connect(),{message:'hub_connect_failed'});await assert.rejects(readFile(path.join(c.root,'hub-connection.json')));
}));
test('Hub timeout/network failure has sanitized diagnostic',async()=>{
  const client=new OpenCodexClient({url:'https://hub.example',credential:{type:'env',name:'METER_HUB_TEST_SECRET'}},{fetchImpl:async()=>{throw new Error(TOKEN);}});
  process.env.METER_HUB_TEST_SECRET=TOKEN;try{await assert.rejects(client.accounts(),{message:'hub_unavailable'});}finally{delete process.env.METER_HUB_TEST_SECRET;}
});
test('Hub secret stdin is private and not stored in a SQLite row',()=>fixture(async c=>{
  await connectHub(c.db,c.config,{url:'https://hub.example',secretStdin:true,input:Readable.from([TOKEN]),fetchImpl:c.fetchImpl});
  const saved=JSON.parse(await readFile(path.join(c.root,'hub-connection.json'),'utf8'));
  assert.equal((await stat(saved.credential.path)).mode&0o777,0o600);assert.equal(await readFile(saved.credential.path,'utf8'),TOKEN);
}));
test('Hub secret files with broad POSIX permissions are rejected',()=>fixture(async c=>{
  await chmod(c.secretFile,0o644);await assert.rejects(c.connect(),/hub_connect_failed/);
}));
for(const url of ['http://hub.example','https://user:pass@hub.example','https://hub.example/?token=secret','file:///private','https://hub.example/nested'])test(`Hub URL boundary rejects ${url.split(':')[0]} unsafe endpoint`,()=>fixture(async c=>{
  await assert.rejects(connectHub(c.db,c.config,{url,secretFile:c.secretFile,fetchImpl:c.fetchImpl}));assert.equal(c.calls.length,0);
}));
test('Account picker displays local aliases but projects away id/email; explicit selection only',()=>fixture(async c=>{
  await c.connect();assert.equal(c.db.prepare('SELECT COUNT(*) n FROM hub_selections').get().n,0);
  const output=await c.attach();assert.match(output.text,/Alias p222bbb/);assert.doesNotMatch(output.text,/@private|raw-id-|hub-private/);
  const selections=c.db.prepare('SELECT * FROM hub_selections').all();assert.equal(selections.length,1);assert.equal(selections[0].log_label,B);assert.equal(selections[0].account_id,c.account.id);
}));
for(const variant of ['missing','duplicate','conflict'])test(`Account list ${variant} label fails closed`,()=>{
  const accounts=[pool(A),pool(B)];if(variant==='missing')delete accounts[0].logLabel;else if(variant==='duplicate')accounts[1].logLabel=A;else accounts[0].isMain=true;
  assert.throws(()=>parseHubAccounts({accounts}),/identity_conflict/);
});
test('Non-TTY attach prints exact ACTION REQUIRED without reading Hub or selecting',()=>fixture(async c=>{
  const output=quiet();await attachOpenCodex(c.db,c.config,{fetchImpl:c.fetchImpl,input:{isTTY:false},output,command:"'/installed agent' profile attach-opencodex"});
  assert.match(output.text,/ACTION REQUIRED:\n'\/installed agent' profile attach-opencodex/);assert.ok(c.calls.every(call=>call.host==='meter.example'));assert.equal(c.db.prepare('SELECT COUNT(*) n FROM hub_selections').get().n,0);
}));
test('Main slot requires warning and explicit yes; it is not a permanent provider identity',()=>fixture(async c=>{
  c.setAccounts([pool('main')]);await c.connect();const answers=['1','no'];const no=await c.attach('1',{question:async()=>answers.shift()});assert.match(no.text,/changing\/re-logging/);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM hub_selections').get().n,0);
  const yes=['1','yes'];await c.attach('1',{question:async()=>yes.shift()});assert.equal(c.db.prepare('SELECT log_label FROM hub_selections').get().log_label,'main');
}));
for(const range of HUB_RANGES)test(`Selected ${range} summary preserves token dimensions/coverage and no other accounts`,()=>{
  const result=parseHubUsage(rawUsage(range),range,B,()=>NOW);assert.equal(result.tokens.totalTokens,'25');assert.equal(result.coverage,0.987);assert.equal(result.counts.attemptCount,1);
  assert.doesNotMatch(JSON.stringify(result),/p111aaa|p222bbb|p333ccc|accountLogLabel|email/);
});
test('Selected account present in account list but absent from ledger is observed zero with zero coverage',()=>{
  const result=parseHubUsage(rawUsage('today',[]),'today',B,()=>NOW);assert.equal(result.tokens.totalTokens,'0');assert.equal(result.coverage,0);assert.equal(result.counts.attemptCount,0);
});
for(const kind of ['ambiguous','duplicate','malformed','unsafe','read_failed','wrong_range','wrong_surface','truncated'])test(`Usage ${kind} is never a confirmed zero`,()=>{
  const data=rawUsage('today');if(kind==='ambiguous')data.accounts[1].ambiguous=true;
  if(kind==='duplicate')data.accounts.push(data.accounts[1]);if(kind==='malformed')delete data.accounts[1].inputTokens;
  if(kind==='unsafe')data.accounts[1].totalTokens=Number.MAX_SAFE_INTEGER+1;if(kind==='read_failed')data.error='read_failed';
  if(kind==='wrong_range')data.range='all';if(kind==='wrong_surface')data.surface='all';if(kind==='truncated')data.entriesTruncated=true;
  assert.throws(()=>parseHubUsage(data,'today',B,()=>NOW));
});
test('Canonical quota uses milliseconds, short duration 5H, Weekly and optional unknown windows',()=>{
  const account=pool(B);account.quota.customWindows=[{label:'private arbitrary provider text',percent:4}];account.quota.monthlyPercent=9;
  const result=parseHubQuota(account,()=>NOW);assert.deepEqual(result.windows.map(w=>w.durationMinutes),[10080,43200,300,null]);assert.equal(result.windows[0].resetsAt,new Date(NOW+86400000).toISOString());assert.doesNotMatch(JSON.stringify(result),/private arbitrary|p222bbb/);
});
test('Quota null/reauth/optional fields do not invent windows or a short duration',()=>{
  assert.equal(parseHubQuota({...pool(B),quota:null},()=>NOW).status,'unavailable');assert.equal(parseHubQuota({...pool(B),needsReauth:true},()=>NOW).status,'unavailable');
  const a=pool(B);delete a.quota.shortWindowSeconds;assert.equal(parseHubQuota(a,()=>NOW).windows.find(w=>w.limitId==='short').durationMinutes,null);
});
test('Wire schema rejects credentials, identity/path fields and malformed counts',()=>{
  const u=parseHubUsage(rawUsage('all'),'all',B,()=>NOW),q=parseHubQuota(pool(B),()=>NOW);
  for(const key of ['email','logLabel','hubUrl','auth','token','codexHome']){assert.throws(()=>validateHubUsage({...u,[key]:'private'}));assert.throws(()=>validateHubQuota({...q,[key]:'private'}));}
  assert.throws(()=>validateHubUsage({...u,counts:{...u.counts,attemptCount:-1}}));assert.throws(()=>validateHubUsage({...u,coverage:1.01}));
});
test('End-to-end Hub enrollment, explicit picker, range snapshots/quota, privacy, no native collectors/events',()=>fixture(async c=>{
  await c.connect();await c.attach();const adapter=new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock});await adapter.sync();
  const detail=c.service.accountDetail(c.account.id),source=detail.usageSource;
  for(const range of HUB_RANGES)assert.equal(source.ranges[range].lastKnownGood.tokens.totalTokens,'25');assert.equal(source.quota.lastKnownGood.windows[0].usedPercent,50);
  assert.equal(source.deviceAttribution,false);assert.deepEqual(detail.devices,[]);assert.equal(c.serverDb.prepare('SELECT COUNT(*) n FROM usage_events').get().n,0);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM usage_outbox').get().n,0);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,0);
  const runtime=new AgentRuntime(c.db,c.config);assert.equal(runtime.collectors.length,0);assert.equal(runtime.syncClient.profileQuotaReporters.length,0);assert.equal(runtime.syncClient.quotaReporter,null);
  const wire=JSON.stringify(c.reports);assert.doesNotMatch(wire,/p111aaa|p222bbb|p333ccc|raw-id|@private|Alias|hub-private|hub\.example|NEVER-READ/);
  const stored=c.serverDb.prepare('SELECT snapshot_json FROM hub_usage_current UNION ALL SELECT snapshot_json FROM hub_quota_current').all();assert.doesNotMatch(JSON.stringify(stored),/p111aaa|p222bbb|p333ccc|raw-id|@private|hub-private/);
  assert.ok(c.calls.filter(call=>call.host==='hub.example').every(call=>!call.search.includes('refresh')));
  assert.equal((await readdir(c.root)).includes('NEVER-READ-NATIVE-HOME'),false);
}));
test('Snapshot retries and stale snapshots never add usage or move observations forward',()=>fixture(async c=>{
  await c.connect();await c.attach();await new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock}).sync();const before=JSON.stringify(c.service.hub.account(c.account.id));
  const report=structuredClone(c.reports[0]);c.service.hub.report(c.service.authenticateDevice(c.config.deviceId,c.config.deviceSecret),report);assert.equal(JSON.stringify(c.service.hub.account(c.account.id)),before);
  report.usage.forEach(u=>{u.observedAt=new Date(NOW-1000).toISOString();u.tokens.totalTokens='777';});c.service.hub.report(c.service.authenticateDevice(c.config.deviceId,c.config.deviceSecret),report);assert.equal(c.service.hub.account(c.account.id).ranges.all.lastKnownGood.tokens.totalTokens,'25');
  c.advance(300001);assert.equal(c.service.hub.account(c.account.id).ranges.all.status,'stale');
}));
for(const kind of ['read_failed','ambiguous','malformed','account_removed','identity_conflict'])test(`${kind} preserves last-known-good but marks unavailable`,()=>fixture(async c=>{
  await c.connect();await c.attach();const adapter=new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock});await adapter.sync();c.advance(60001);
  if(kind==='account_removed')c.setAccounts([pool(A),pool(C)]);else if(kind==='identity_conflict')c.setAccounts([pool(B),pool(B)]);
  else c.setUsage(data=>{if(kind==='read_failed')data.error=kind;else if(kind==='ambiguous')data.accounts[1].ambiguous=true;else delete data.accounts;return data;});
  await adapter.sync();const range=c.service.hub.account(c.account.id).ranges.all;assert.equal(range.lastKnownGood.tokens.totalTokens,'25');assert.equal(range.status,kind);
}));
test('Restart preserves selected label; quota cadence and stop/re-add isolate histories',()=>fixture(async c=>{
  await c.connect();await c.attach();const adapter=new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock});await adapter.sync();const count=c.calls.filter(x=>x.host==='hub.example').length;
  await adapter.sync();assert.equal(c.calls.filter(x=>x.host==='hub.example').length,count);
  const reopened=openAgentDatabase(c.config.databasePath);try{assert.equal(reopened.prepare('SELECT log_label FROM hub_selections').get().log_label,B);await new HubAdapter(reopened,c.config,{fetchImpl:c.fetchImpl,clock:c.clock}).sync();}finally{reopened.close();}
  const binding=c.service.hub.desired({id:c.config.deviceId}).profiles[0].bindingId;c.service.disableBinding(c.config.deviceId,binding);await adapter.sync();assert.equal(c.db.prepare('SELECT COUNT(*) n FROM hub_selections').get().n,0);assert.equal(c.service.hub.account(c.account.id).state,'stopped');
  c.service.bindAccount(c.config.deviceId,{accountId:c.account.id,mode:'opencodex'});await c.attach();c.advance(60001);await adapter.sync();
  assert.equal(c.serverDb.prepare('SELECT COUNT(*) n FROM hub_usage_current').get().n,8);assert.equal(c.service.hub.account(c.account.id).ranges.all.lastKnownGood.tokens.totalTokens,'25');
}));
test('Unbound/stopped/wrong reporter payloads rejected without any native or Hub writes',()=>fixture(async c=>{
  await c.connect();await c.attach();await new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock}).sync();const report=c.reports[0];
  assert.throws(()=>c.service.hub.report({id:'other'},report),/hub_not_bound/);c.service.disableBinding(c.config.deviceId,report.bindingId);assert.throws(()=>c.service.hub.report({id:c.config.deviceId},report),/hub_not_bound/);
}));
test('Hub source cannot receive native bindings; one reporter per profile prevents double counting',()=>fixture(async c=>{
  assert.throws(()=>c.service.bindAccount(c.config.deviceId,{accountId:c.account.id,mode:'default'}),/invalid_source_mode/);
  assert.throws(()=>c.service.bindAccount(c.config.deviceId,{accountId:c.account.id,mode:'opencodex'}),/already_bound/);
  assert.throws(()=>c.service.updateAccount(c.account.id,{measurementSource:'native_rollout'}));
}));
test('Old Agent cannot consume Hub enrollment; native defaults retain old wire config',()=>fixture(async c=>{
  const a=c.service.createAccount({name:'Another hub',measurementSource:'opencodex_proxy'}),e=c.service.createDevice({name:'Hub old agent',accountId:a.id,mode:'opencodex'});
  assert.throws(()=>c.service.enroll({token:e.enrollmentToken},SERVER_CAPABILITIES),/compatible_agent_required/);
  const native=c.service.createAccount({name:'Native'}),n=c.service.createDevice({name:'Native',accountId:native.id,mode:'default'}),result=c.service.enroll({token:n.enrollmentToken},SERVER_CAPABILITIES);
  assert.equal(result.agentConfiguration.profiles[0].mode,'default');assert.equal(result.opencodexHub,undefined);assert.equal(JSON.stringify(result.agentConfiguration).includes('opencodex'),false);
}));
test('New Agent with old Server fails closed without accessing Hub',()=>fixture(async c=>{
  let calls=0;await assert.rejects(meterHubRequest(c.config,'GET',undefined,async()=>{calls++;return new Response('{}',{status:404});}),/unsupported_server/);assert.equal(calls,1);
}));
test('Remote Hub configuration cannot supply URL, commands, identity or duplicate profiles',()=>{
  const p={accountId:'a',bindingId:'b',name:'<img src=x onerror=alert(1)>'};assert.equal(validateHubDesired({schemaVersion:1,profiles:[p]}).profiles[0].name,p.name);
  for(const field of ['url','logLabel','token','command','codexHome'])assert.throws(()=>validateHubDesired({schemaVersion:1,profiles:[{...p,[field]:'private'}]}));
  assert.throws(()=>validateHubDesired({schemaVersion:1,profiles:[p,p]}));
});
test('Authenticated HTTP Hub route requires capability and Device secret, not admin session',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hub-http-test-')),db=openServerDatabase(path.join(root,'server.db'));
  const server=createV2Server({database:db,adminPassword:'synthetic admin password'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}`,headers={'x-forwarded-proto':'https','content-type':'application/json'};
    const service=new MeterService(db),account=service.createAccount({name:'Hub HTTP',measurementSource:'opencodex_proxy'}),pending=service.createDevice({name:'HTTP reporter',accountId:account.id,mode:'opencodex'});
    const enrolled=await fetch(`${url}/api/v1/agent/enroll`,{method:'POST',headers:{...headers,'x-codex-meter-capabilities':AGENT_CAPABILITY_HEADER_VALUE,'x-codex-meter-opencodex':'1'},body:JSON.stringify({token:pending.enrollmentToken})});assert.equal(enrolled.status,201);const value=await enrolled.json();
    const auth={...headers,authorization:`Bearer ${value.deviceId}.${value.deviceSecret}`,'x-codex-meter-opencodex':'1'};
    const desired=await fetch(`${url}/api/v1/agent/hub`,{headers:auth});assert.equal(desired.status,200);assert.equal((await desired.json()).profiles[0].accountId,account.id);
    assert.equal((await fetch(`${url}/api/v1/agent/hub`,{headers})).status,426);
    assert.equal((await fetch(`${url}/api/v1/agent/hub`,{headers:{...headers,'x-codex-meter-opencodex':'1'}})).status,401);
    assert.equal((await fetch(`${url}/api/v1/agent/hub`,{method:'POST',headers:auth,body:JSON.stringify({token:TOKEN})})).status,400);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();await rm(root,{recursive:true,force:true});}
});
test('Bare existing attach defaults to discovery; explicit flag compatible, no auto-selection',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'bare-existing-test-')),db=openAgentDatabase(path.join(root,'agent.db'));
  try{
    const config={databasePath:path.join(root,'agent.db'),codexHome:path.join(root,'unused')};
    const declaration={schemaVersion:1,revision:1,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles:[{bindingId:'b',accountId:'a',name:'Personal',mode:'existing',selectionKey:'s'}]};await applyDesiredConfiguration(db,config,declaration);
    for(const extra of [{},{discover:true}]){const output=quiet();await selectExistingProfiles(db,config,{...extra,searchRoots:[root],output,question:async()=>'c'});assert.match(output.text,/Local search only/);assert.match(output.text,/Cancelled/);assert.equal(db.prepare('SELECT COUNT(*) n FROM existing_home_selections').get().n,0);}
  }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('Two pending Hub profiles require a readable Profile selection before account selection',()=>fixture(async c=>{
  const second=c.service.createAccount({name:'Research \u001b label',measurementSource:'opencodex_proxy'});c.advance(1);c.service.bindAccount(c.config.deviceId,{accountId:second.id,mode:'opencodex'});
  await c.connect();const answers=['2','2'];const output=await c.attach('2',{question:async()=>answers.shift()});
  const selected=c.db.prepare('SELECT * FROM hub_selections').get();assert.equal(selected.account_id,second.id);assert.equal(selected.log_label,B);assert.doesNotMatch(output.text,/\u001b/);
  assert.ok(!output.text.includes(second.id));assert.ok(!output.text.includes(c.account.id));
  await assert.rejects(c.attach('2'),/account_already_selected/);
}));
test('Runtime heartbeat drives Hub snapshots without Native quota, collectors, or manual restart',()=>fixture(async c=>{
  await c.connect();await c.attach();const adapter=new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock});
  const runtime=new AgentRuntime(c.db,c.config,{fetchImpl:c.fetchImpl,hubAdapter:adapter,quotaReporterFactory:()=>{throw Error('Hub must not instantiate Codex App Server');}});
  await runtime.sync(true);assert.equal(c.reports.length,1);assert.equal(c.service.hub.account(c.account.id).ranges.today.lastKnownGood.tokens.totalTokens,'25');assert.equal(runtime.collectors.length,0);
  await runtime.stop();
}));
test('Quota refresh failure retains last-known-good, does not overwrite it with zero',()=>fixture(async c=>{
  await c.connect();await c.attach();const adapter=new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock});await adapter.sync();
  c.advance(60001);const b=pool(B);b.quotaRefresh={status:'network_error'};c.setAccounts([pool(A),b,pool(C)]);await adapter.sync();
  const quota=c.service.hub.account(c.account.id).quota;assert.equal(quota.status,'unavailable');assert.equal(quota.lastKnownGood.windows[0].usedPercent,50);
}));
test('Short quota observation cannot be made fresh by a newer weekly/cache update',()=>{
  const account=pool(B);account.quota.shortObservedAt=NOW-600000;assert.equal(parseHubQuota(account,()=>NOW).observedAt,new Date(NOW-600000).toISOString());
});
test('Identical cached quota recovers after transient failure without renewing its observedAt',()=>fixture(async c=>{
  await c.connect();await c.attach();const adapter=new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock});await adapter.sync();
  c.advance(60001);c.setAccountStatus(503);await adapter.sync();assert.equal(c.service.hub.account(c.account.id).quota.status,'unavailable');
  c.advance(60001);c.setAccountStatus(200);await adapter.sync();const quota=c.service.hub.account(c.account.id).quota;
  assert.equal(quota.status,'available');assert.equal(quota.lastKnownGood.observedAt,new Date(NOW).toISOString());
}));
test('Deleting a reporter frees Hub profile while retaining its snapshots',()=>fixture(async c=>{
  await c.connect();await c.attach();await new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock}).sync();c.service.removeDevice(c.config.deviceId);
  assert.equal(c.service.hub.account(c.account.id).state,'stopped');assert.equal(c.serverDb.prepare('SELECT COUNT(*) n FROM hub_usage_current').get().n,4);
  const next=c.service.createDevice({name:'Replacement',accountId:c.account.id,mode:'opencodex'});assert.ok(c.service.enroll({token:next.enrollmentToken},caps).deviceId);
}));
test('Two explicitly selected Hub accounts retain separate usage and quota after adapter restart',()=>fixture(async c=>{
  c.setAccounts([pool(A,11),pool(B,22),pool(C,33)]);await c.connect();c.advance(1);
  const second=c.service.createAccount({name:'Second selected Profile',measurementSource:'opencodex_proxy'});c.service.bindAccount(c.config.deviceId,{accountId:second.id,mode:'opencodex'});
  const answers=['1','1'];await c.attach('1',{question:async()=>answers.shift()});await c.attach('2');
  for(let restart=0;restart<2;restart++){
    await new HubAdapter(c.db,c.config,{fetchImpl:c.fetchImpl,clock:c.clock}).sync();
    const a=c.service.hub.account(c.account.id),b=c.service.hub.account(second.id);
    assert.equal(a.ranges.all.lastKnownGood.tokens.totalTokens,'999');assert.equal(b.ranges.all.lastKnownGood.tokens.totalTokens,'25');
    assert.equal(a.quota.lastKnownGood.windows[0].usedPercent,11);assert.equal(b.quota.lastKnownGood.windows[0].usedPercent,22);
  }
  assert.equal(c.serverDb.prepare('SELECT COUNT(*) n FROM usage_events').get().n,0);assert.doesNotMatch(JSON.stringify(c.reports),/p333ccc|p111aaa|p222bbb|@private/);
}));
