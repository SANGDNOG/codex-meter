import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openServerDatabase } from '../v2/server/database.js';
import { openAgentDatabase } from '../v2/agent/database.js';
import { MeterService, ServiceError } from '../v2/server/service.js';
import { createV2Server } from '../v2/server/http.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
import { normalizeQuota, QuotaReporter, ReadOnlyAppServerClient } from '../v2/agent/app-server.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

async function fakeAppServer(scriptBody, callback) {
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-m4-app-'));const executable=path.join(root,'codex');const calls=path.join(root,'calls.jsonl');
  await writeFile(executable,`#!/usr/bin/env node\n${scriptBody}\n`);await chmod(executable,0o700);
  try{return await callback({executable,calls});}finally{await rm(root,{recursive:true,force:true});}
}

const normalFake = `const fs=require('node:fs');const readline=require('node:readline');const out=process.env.CALLS;const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const x=JSON.parse(line);fs.appendFileSync(out,JSON.stringify(x)+'\\n');if(x.method==='initialized')return;process.stdout.write(JSON.stringify({method:'notice',params:{prompt:'PRIVATE'}})+'\\n');if(x.method==='initialize')process.stdout.write(JSON.stringify({id:x.id,result:{capabilities:{private:'SECRET'}}})+'\\n');else if(x.method==='account/read')process.stdout.write(JSON.stringify({id:x.id,result:{account:{planType:'pro',email:'PRIVATE'}}})+'\\n');else if(x.method==='account/rateLimits/read')process.stdout.write(JSON.stringify({id:x.id,result:{rateLimits:{limitId:'codex',primary:{windowDurationMins:300,usedPercent:12,resetsAt:'2026-08-30T13:00:00Z',prompt:'PRIVATE'},secondary:{windowDurationMins:10080,usedPercent:25,resetsAt:'2026-09-06T12:00:00Z'}},rawResponse:'PRIVATE'}})+'\\n')})`;

test('M4 App Server performs bounded correlated handshake and only fixed read-only operations', async()=>fakeAppServer(normalFake,async({executable,calls})=>{
  const previous=process.env.CALLS;process.env.CALLS=calls;
  try{const reporter=new QuotaReporter({command:executable,timeoutMs:2000,clock:()=>NOW});const result=await reporter.observe();assert.equal(result.status,'available');assert.deepEqual(result.windows.map(x=>[x.limitId,x.durationMinutes]),[['codex',300],['codex',10080]]);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
    const sent=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(sent.map(x=>x.method),['initialize','initialized','account/read','account/rateLimits/read']);assert.equal(sent[0].id+1,sent[2].id);assert.deepEqual(sent[2].params,{refreshToken:false});assert.ok(sent.every(x=>!String(x.method).includes('login')&&!String(x.method).includes('logout')&&!String(x.method).includes('consume')&&!String(x.method).includes('reset')));
    assert.equal(typeof ReadOnlyAppServerClient.prototype.request,'undefined');
  }finally{if(previous===undefined)delete process.env.CALLS;else process.env.CALLS=previous;}
}));

test('M4 App Server ignores malformed, oversized, notifications, wrong IDs and never leaks raw stderr/response',async()=>fakeAppServer(`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const x=JSON.parse(line);process.stderr.write('STDERR_PRIVATE');if(x.method==='initialized')return;if(x.method==='initialize')return process.stdout.write(JSON.stringify({id:x.id,result:{}})+'\\n');process.stdout.write('{bad\\n');process.stdout.write(JSON.stringify({noise:'X'.repeat(2000)})+'\\n');process.stdout.write(JSON.stringify({id:999,result:{prompt:'RESPONSE_PRIVATE'}})+'\\n');if(x.method==='account/read')return process.stdout.write(JSON.stringify({id:x.id,result:{account:{planType:'unknown-secret-plan'}}})+'\\n');process.stdout.write(JSON.stringify({id:x.id,result:{rateLimits:{limitId:'codex',primary:{windowDurationMins:'bad',usedPercent:1,prompt:'PRIVATE'}}}})+'\\n')})`,async({executable})=>{
  const report=await new QuotaReporter({command:executable,timeoutMs:2000,maxLineBytes:1024,clock:()=>NOW}).observe();assert.deepEqual(report,{observedAt:new Date(NOW).toISOString(),status:'unavailable',errorKind:'malformed_rate_limits',planType:null,windows:[]});assert.equal(JSON.stringify(report).includes('PRIVATE'),false);
}));

test('M4 quota normalization uses limitId+duration identity across slot reorder; duplicate/missing identity is explicit',()=>{
  const left=normalizeQuota({rateLimits:{limitId:'codex',primary:{windowDurationMins:300,usedPercent:1},secondary:{windowDurationMins:10080,usedPercent:2}}});
  const right=normalizeQuota({rateLimits:{limitId:'codex',secondary:{windowDurationMins:300,usedPercent:1},primary:{windowDurationMins:10080,usedPercent:2}}});
  assert.deepEqual(left.windows.map(x=>`${x.limitId}:${x.durationMinutes}`),right.windows.map(x=>`${x.limitId}:${x.durationMinutes}`));assert.notDeepEqual(left.windows.map(x=>x.slot),right.windows.map(x=>x.slot));
  assert.equal(normalizeQuota({rateLimits:{limitId:'codex',primary:{windowDurationMins:300,usedPercent:1},secondary:{windowDurationMins:300,usedPercent:2}}}).status,'ambiguous');
  assert.equal(normalizeQuota({rateLimits:{primary:{windowDurationMins:300,usedPercent:1}}}).status,'unavailable');
});

test('M4 quota normalization accepts Codex 0.137 null optional windows and canonicalizes duplicate aliases',()=>{
  const shared={limitId:'codex',planType:'pro',primary:{windowDurationMins:300,usedPercent:12,resetsAt:1788249600},secondary:null,windows:null};
  const canonical={
    codex:{...shared,primary:{...shared.primary}},
    research:{limitId:'research',planType:'pro',primary:{windowDurationMins:300,usedPercent:8,resetsAt:1788249600},secondary:{windowDurationMins:10080,usedPercent:2,resetsAt:1788854400}}
  };
  const result=normalizeQuota({rateLimits:{...shared,primary:{...shared.primary,usedPercent:99}},rateLimitsByLimitId:canonical});
  assert.equal(result.status,'available');assert.equal(result.errorKind,undefined);assert.equal(result.planType,'pro');
  assert.deepEqual(result.windows.map(x=>`${x.limitId}:${x.durationMinutes}`),['codex:300','research:300','research:10080']);
  assert.equal(result.windows.find(x=>x.limitId==='codex').usedPercent,12);
  assert.equal(normalizeQuota({rateLimits:{...shared,primary:null,secondary:null,windows:[{limitId:'codex',durationMinutes:300,usedPercent:1}]}}).status,'available');
  assert.equal(normalizeQuota({rateLimits:{...shared,primary:'malformed'}}).status,'unavailable');
  assert.equal(normalizeQuota({rateLimits:shared,rateLimitsByLimitId:{}}).status,'available');
  const assertMalformed=(value)=>{assert.equal(value.status,'unavailable');assert.equal(value.errorKind,'malformed_rate_limits');};
  for(const absent of [null,undefined]) assert.equal(normalizeQuota({rateLimits:shared,rateLimitsByLimitId:absent}).status,'available');
  for(const malformed of [[], 'malformed']) assertMalformed(normalizeQuota({rateLimits:shared,rateLimitsByLimitId:malformed}));
  for(const malformed of [null,[], 'malformed',{}, {primary:null,secondary:null,windows:null}, {limitId:'empty'}])
    assertMalformed(normalizeQuota({rateLimitsByLimitId:{codex:canonical.codex,malformed}}));
});

async function serverFixture(callback){const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-m4-server-'));const database=openServerDatabase(path.join(root,'db.sqlite'));let now=NOW;try{const service=new MeterService(database,{adminPassword:'long enough test password',clock:()=>now,quotaStaleMs:60_000});
  const add=(id)=>{database.prepare('INSERT INTO devices(id,name,credential_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,id,'hash',new Date(now).toISOString(),new Date(now).toISOString());return database.prepare('SELECT * FROM devices WHERE id=?').get(id);};await callback({database,service,a:add('reporter'),b:add('other'),advance(ms){now+=ms;}});
  }finally{database.close();await rm(root,{recursive:true,force:true});}}
function sync(quotaReport){return{agentVersion:'2.0',codexVersion:null,events:[],health:{status:'healthy'},...(quotaReport?{quotaReport}:{})};}
function available(percent=10,at=NOW){return{observedAt:new Date(at).toISOString(),status:'available',planType:'pro',windows:[{limitId:'codex',durationMinutes:300,usedPercent:percent,resetsAt:'2026-08-30T13:00:00.000Z',slot:'primary'}]};}

test('M4 server rejects non-reporter quota, atomically replaces reporter current, persists snapshots, and marks stale',()=>serverFixture(async({database,service,a,b,advance})=>{
  service.updateSettings({quotaReporterDeviceId:a.id});assert.throws(()=>service.sync(b,sync(available())),error=>error instanceof ServiceError&&error.status===403);assert.equal(database.prepare('SELECT count(*) n FROM quota_current').get().n,0);
  service.sync(a,sync(available(10)));assert.equal(service.quotaCurrent().status,'available');assert.equal(service.quotaCurrent().windows[0].usedPercent,10);
  service.sync(a,sync(available(20,NOW+1)));assert.equal(service.quotaCurrent().windows[0].usedPercent,20);assert.equal(database.prepare('SELECT count(*) n FROM quota_current').get().n,1);assert.equal(database.prepare('SELECT count(*) n FROM quota_snapshots').get().n,2);
  advance(60_002);assert.equal(service.quotaCurrent().status,'stale');assert.equal(service.quotaCurrent().sourceStatus,'available');
  service.updateSettings({quotaReporterDeviceId:b.id});assert.equal(service.quotaCurrent().status,'unavailable');
}));

test('M4 current quota is exposed through the authenticated versioned API',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-m4-http-'));const database=openServerDatabase(path.join(root,'db.sqlite'));const server=createV2Server({database,adminPassword:'long enough test password',clock:()=>NOW});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{const login=await fetch(`${base}/api/v1/auth/login`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'long enough test password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(`${base}/api/v1/quota/current`,{headers:{origin:base,cookie}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{observedAt:null,status:'unavailable',reporterState:'no_reporter',reporterDeviceId:null,errorKind:null,planType:null,windows:[]});
  }finally{await new Promise(resolve=>server.close(resolve));database.close();await rm(root,{recursive:true,force:true});}
});

test('M4 server strictly rejects malformed/private quota fields and Agent reports quota only after designation',async()=>{
  await serverFixture(async({database,service,a})=>{service.updateSettings({quotaReporterDeviceId:a.id});assert.throws(()=>service.sync(a,sync({...available(),prompt:'PRIVATE'})),/invalid_body/);assert.equal(database.prepare('SELECT count(*) n FROM quota_snapshots').get().n,0);});
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-m4-agent-'));const database=openAgentDatabase(path.join(root,'agent.db'));let calls=0,observations=0,bodies=[];
  try{const client=new AgentSyncClient(database,{serverUrl:'https://meter.example',deviceId:'agent',deviceSecret:'x'.repeat(32),maxBatchSize:100},{quotaReporter:{observe:async()=>{observations++;return available();}},fetchImpl:async(_url,request)=>{calls++;bodies.push(JSON.parse(request.body));return{ok:true,json:async()=>({acceptedEventIds:[],duplicateEventIds:[],isQuotaReporter:true})};}});
    await client.sync({heartbeat:true});assert.equal(observations,0);assert.equal('quotaReport'in bodies[0],false);await client.sync();assert.equal(observations,1);assert.equal(bodies[1].quotaReport.status,'available');assert.equal(calls,2);
  }finally{database.close();await rm(root,{recursive:true,force:true});}
});

test('M4 has no absolute token-to-quota estimator and labels V2.1 proportional allocation as estimated',async()=>{
  for(const file of ['v2/agent/app-server.js','v2/agent/sync.js']){const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');assert.doesNotMatch(source,/tokens?\s*(?:to|per)\s*quota|estimat(?:e|or).*quota/i);}
  const service=await readFile(new URL('../v2/server/service.js',import.meta.url),'utf8');assert.doesNotMatch(service,/tokens?\s*(?:to|per)\s*quota/i);assert.match(service,/quotaContribution/);assert.match(service,/estimatedQuotaContributionPercentagePoints/);assert.match(service,/estimated_not_provider_attributed/);
});
