import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openServerDatabase } from '../v2/server/database.js';
import { createV2Server } from '../v2/server/http.js';

const PASSWORD='dashboard test password';
async function fixture(run){const dir=await mkdtemp(path.join(os.tmpdir(),'meter-m5-'));const db=openServerDatabase(path.join(dir,'db.sqlite'));let now=Date.parse('2026-08-30T12:00:00Z');const server=createV2Server({database:db,adminPassword:PASSWORD,serverUrl:'https://meter.example',clock:()=>now});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;const request=async(route,{method='GET',body,cookie,csrf,origin=true}={})=>{const headers={'x-forwarded-proto':'https'};if(origin)headers.origin=base.replace('http:','https:');if(body!==undefined)headers['content-type']='application/json';if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}return{response,value,cookie:response.headers.get('set-cookie')?.split(';')[0]};};try{await run({request,db,advance:ms=>{now+=ms;}});}finally{await new Promise(resolve=>server.close(resolve));db.close();await rm(dir,{recursive:true,force:true});}}
async function login(ctx){const result=await ctx.request('/api/v1/auth/login',{method:'POST',body:{password:PASSWORD}});assert.equal(result.response.status,200);return{cookie:result.cookie,csrf:result.value.csrfToken};}
const admin=(ctx,auth,route,init={})=>ctx.request(route,{...init,cookie:auth.cookie,csrf:auth.csrf});

test('M5 dashboard assets are same-server, strict-CSP, correctly typed, cache controlled, and safe-DOM browser JS parses',async()=>fixture(async ctx=>{
  const index=await ctx.request('/',{origin:false});assert.equal(index.response.status,200);assert.match(index.response.headers.get('content-type'),/^text\/html/);assert.equal(index.response.headers.get('cache-control'),'no-store');assert.match(index.response.headers.get('content-security-policy'),/default-src 'none'/);assert.match(index.response.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(index.response.headers.get('x-content-type-options'),'nosniff');assert.match(index.value,/\/app\.js/);
  const js=await ctx.request('/app.js',{origin:false});assert.match(js.response.headers.get('content-type'),/^text\/javascript/);assert.match(js.response.headers.get('cache-control'),/^public/);
  const css=await ctx.request('/styles.css',{origin:false});assert.match(css.response.headers.get('content-type'),/^text\/css/);
  const source=await readFile(new URL('../v2/web/app.js',import.meta.url),'utf8');assert.equal(spawnSync(process.execPath,['--check',new URL('../v2/web/app.js',import.meta.url).pathname]).status,0);assert.doesNotMatch(source,/\.innerHTML\b|localStorage|sessionStorage|Authorization\s*:/);assert.match(source,/Share of measured token usage/);
}));

test('M5 static dashboard is public but every admin data/action API remains session and CSRF protected',async()=>fixture(async ctx=>{
  for(const route of ['/api/v1/groups','/api/v1/devices','/api/v1/settings','/api/v1/quota/current','/api/v1/usage/summary?range=all','/api/v1/device-enrollments/not-real'])assert.equal((await ctx.request(route)).response.status,401,route);
  assert.equal((await ctx.request('/api/v1/groups',{method:'POST',body:{name:'x'}})).response.status,401);
  const auth=await login(ctx);assert.equal((await ctx.request('/api/v1/groups',{method:'POST',body:{name:'x'},cookie:auth.cookie})).response.status,403);
  const created=await admin(ctx,auth,'/api/v1/groups',{method:'POST',body:{name:'<img src=x onerror=alert(1)>'}});assert.equal(created.response.status,201);assert.equal(created.value.name,'<img src=x onerror=alert(1)>');
}));

test('M5 configurable device states and enrollment polling endpoint cover pending, connected, stale, offline, and disabled',async()=>fixture(async ctx=>{
  const auth=await login(ctx);const settings=await admin(ctx,auth,'/api/v1/settings',{method:'PATCH',body:{onlineThresholdSeconds:60,staleThresholdSeconds:120}});assert.equal(settings.value.onlineThresholdSeconds,'60');assert.equal(settings.value.staleThresholdSeconds,'120');
  const pending=await admin(ctx,auth,'/api/v1/devices',{method:'POST',body:{name:'Laptop',groupId:null}});const statusPending=await admin(ctx,auth,`/api/v1/device-enrollments/${pending.value.enrollmentId}`);assert.equal(statusPending.value.status,'pending');
  const enrollment=await ctx.request('/api/v1/agent/enroll',{method:'POST',body:{token:pending.value.enrollmentToken}});assert.equal(enrollment.response.status,201);const connected=await admin(ctx,auth,`/api/v1/device-enrollments/${pending.value.enrollmentId}`);assert.equal(connected.value.status,'connected');assert.equal(connected.value.deviceId,enrollment.value.deviceId);
  const credential=`Bearer ${enrollment.value.deviceId}.${enrollment.value.deviceSecret}`;const sync=await fetch(`${connected.response.url.split('/api/')[0]}/api/v1/agent/sync`,{method:'POST',headers:{authorization:credential,'content-type':'application/json','x-forwarded-proto':'https'},body:JSON.stringify({agentVersion:'2',codexVersion:'2',events:[],health:{status:'healthy'}})});assert.equal(sync.status,200);
  let device=(await admin(ctx,auth,`/api/v1/devices/${enrollment.value.deviceId}`)).value;assert.equal(device.state,'online');ctx.advance(60_000);device=(await admin(ctx,auth,`/api/v1/devices/${enrollment.value.deviceId}`)).value;assert.equal(device.state,'stale');ctx.advance(61_000);device=(await admin(ctx,auth,`/api/v1/devices/${enrollment.value.deviceId}`)).value;assert.equal(device.state,'offline');await admin(ctx,auth,`/api/v1/devices/${enrollment.value.deviceId}/disable`,{method:'POST',body:{disabled:true}});device=(await admin(ctx,auth,`/api/v1/devices/${enrollment.value.deviceId}`)).value;assert.equal(device.state,'disabled');
  assert.equal((await admin(ctx,auth,'/api/v1/settings',{method:'PATCH',body:{onlineThresholdSeconds:200,staleThresholdSeconds:100}})).response.status,400);
}));
