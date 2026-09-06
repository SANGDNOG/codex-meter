import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, lstat, lutimes, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { QuotaReporter, ReadOnlyAppServerClient } from '../../v2/agent/app-server.js';
import { ExistingHomeQuotaRunner, reapQuotaScratch, quotaScratchRoot } from '../../v2/agent/existing-quota-runner.js';
import { validateExistingHome } from '../../v2/agent/existing-home.js';
import { openAgentDatabase } from '../../v2/agent/database.js';
import { applyDesiredConfiguration } from '../../v2/agent/assignments.js';
import { attachExistingHome } from '../../v2/agent/attach-existing.js';
import { validateConfig } from '../../v2/agent/config.js';

async function scratchEntries(){try{return await readdir(quotaScratchRoot());}catch(error){if(error.code==='ENOENT')return [];throw error;}}

async function inventory(root) {
  const rows=[];
  for(const name of (await readdir(root,{recursive:true})).sort()){
    const filename=path.join(root,name),info=await lstat(filename);
    rows.push([name,info.mode,info.uid,info.gid,info.size,info.mtimeMs,info.ctimeMs,
      info.isSymbolicLink()?await readlink(filename):info.isFile()?await readFile(filename,'utf8'):null]);
  }
  return rows;
}

async function fixture(run){
  const root=await mkdtemp('/var/tmp/meter-quota-enforcement-');
  const homes=[path.join(root,'home-a'),path.join(root,'home-b')];
  for(const [index,home] of homes.entries()){
    await mkdir(path.join(home,'sessions'),{recursive:true});
    await writeFile(path.join(home,'config.toml'),`fixture_account = ${index+1}\n`);
    await writeFile(path.join(home,'auth.json'),'NOT A CREDENTIAL: synthetic fixture');
    await writeFile(path.join(home,'sessions','old.jsonl'),'synthetic history');
  }
  try{await run({root,homes});}finally{await rm(root,{recursive:true,force:true});}
}

async function fake(root,other,behavior='normal'){
  const command=path.join(root,`fake-${behavior}.cjs`);
  await writeFile(command,`#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline'),path=require('node:path');
const home=process.env.CODEX_HOME,sqlite=process.env.CODEX_SQLITE_HOME;
if(!process.argv.includes('--strict-config'))throw Error('unsafe default-config fallback');
if(!sqlite||sqlite.startsWith(home+'/'))throw Error('sqlite was not redirected');
if(fs.existsSync(${JSON.stringify(other)}))throw Error('unselected Home is visible');
if(process.env.CODEX_ACCESS_TOKEN||process.env.OPENAI_API_KEY||process.env.NODE_OPTIONS)throw Error('inherited credential context');
for(const descriptor of fs.readdirSync('/proc/self/fd')){try{const descriptorPath='/proc/self/fd/'+descriptor;if(Number(descriptor)>2&&(fs.statSync(descriptorPath).isDirectory()||/\\/(auth\\.json|config\\.toml)$/.test(fs.readlinkSync(descriptorPath))))throw Error('source fd leaked');}catch(e){if(e.message==='source fd leaked')throw e;}}
const settings=process.argv.filter((v,i,a)=>a[i-1]==='-c');
const log=JSON.parse(settings.find(v=>v.startsWith('log_dir=')).slice(8));
if(log.startsWith(home+'/'))throw Error('logs were not redirected');
for(const dir of [sqlite,log,path.join(home,'tmp','arg0')])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(sqlite,'state.db'),'scratch');fs.writeFileSync(path.join(log,'app.log'),'scratch');
fs.writeFileSync(path.join(home,'installation_id'),'disposable installation');
if(${JSON.stringify(behavior)}==='forbidden')fs.writeFileSync(path.join(home,'auth.json'),'FORBIDDEN');
if(${JSON.stringify(behavior)}==='crash')process.exit(7);
if(${JSON.stringify(behavior)}==='system-config'){
 for(const name of ['config.toml','requirements.toml','managed_config.toml']){
  const filename='/etc/codex/'+name;if(!fs.readFileSync(filename,'utf8').includes('Codex Meter synthetic'))throw Error('system configuration lost');
  try{fs.writeFileSync(filename,'FORBIDDEN');throw Error('system config became writable');}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e;}
 }
}
if(${JSON.stringify(behavior)}==='timeout'){setInterval(()=>{},1000);}else{
fs.readFileSync(path.join(home,'auth.json')); // Synthetic sentinel, read only by fake Codex.
const account=fs.readFileSync(path.join(home,'config.toml'),'utf8').includes('= 1')?11:77;
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.method==='initialized')return;
if(${JSON.stringify(behavior)}==='protocol'&&x.method==='account/rateLimits/read'){process.stdout.write(JSON.stringify({id:x.id,error:{message:'synthetic private protocol failure'}})+'\\n');return;}
if(${JSON.stringify(behavior)}==='managed-auto'&&(x.method==='account/read'||x.method==='account/rateLimits/read'))throw Error('unsupported policy reached account probe');
const result=x.method==='initialize'?{}:x.method==='config/read'?{config:{cli_auth_credentials_store:'file'}}:x.method==='configRequirements/read'?{requirements:${JSON.stringify(behavior)}==='managed-auto'?{cliAuthCredentialsStore:'auto'}:null}:x.method==='account/read'?{account:{type:'chatgpt'}}:{rateLimits:{limitId:'codex',primary:{windowDurationMins:300,usedPercent:account},secondary:{windowDurationMins:10080,usedPercent:account}}};
process.stdout.write(JSON.stringify({id:x.id,result})+'\\n');});}
`);await chmod(command,0o755);return command;
}

test('Capability is mandatory: Bubblewrap must enforce namespaces, not return unavailable',()=>fixture(async({root,homes})=>{
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));
}));

test('Quota accepts the persisted selected root identity without changing its context',()=>fixture(async({root,homes})=>{
  const info=await lstat(homes[0],{bigint:true}),rootIdentity={home:homes[0],dev:String(info.dev),ino:String(info.ino),birthtimeNs:String(info.birthtimeNs)};
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),isolationOptions:{rootIdentity},timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));assert.equal(report.windows[0].usedPercent,11);
}));

test('Quota rejects a reused directory inode with a different saved creation identity before input pins',()=>fixture(async({root,homes})=>{
  const info=await lstat(homes[0],{bigint:true}),rootIdentity={home:homes[0],dev:String(info.dev),ino:String(info.ino),birthtimeNs:String(info.birthtimeNs-1n)};
  const runner=new ExistingHomeQuotaRunner({codexHome:homes[0],command:await fake(root,homes[1]),rootIdentity});
  const original=runner.pin.bind(runner);let inputs=0;
  runner.pin=async(filename,...args)=>{if(['auth.json','config.toml'].includes(filename))inputs++;return original(filename,...args);};
  try{await assert.rejects(runner.prepare(),{kind:'write_isolation_failed'});assert.equal(inputs,0);}finally{await runner.cleanup();}
}));

test('Quota rejects a real B directory moved onto A before any auth/config pin or Codex launch',()=>fixture(async({root,homes})=>{
  const info=await lstat(homes[0],{bigint:true}),rootIdentity={home:homes[0],dev:String(info.dev),ino:String(info.ino),birthtimeNs:String(info.birthtimeNs)};
  const command=await fake(root,homes[1]);await rename(homes[0],path.join(root,'saved-a'));await rename(homes[1],homes[0]);
  const runner=new ExistingHomeQuotaRunner({codexHome:homes[0],command,rootIdentity});const original=runner.pin.bind(runner);let inputs=0;
  runner.pin=async(filename,...args)=>{if(['auth.json','config.toml'].includes(filename))inputs++;return original(filename,...args);};
  try{await assert.rejects(runner.prepare(),{kind:'write_isolation_failed'});assert.equal(inputs,0);}finally{await runner.cleanup();}
}));

for(const existingId of [false,true])test(`Valid quota with zero source mutation; installation_id initially ${existingId?'present':'absent'}`,()=>fixture(async({root,homes})=>{
  if(existingId){await writeFile(path.join(homes[0],'installation_id'),'original installation identifier');await chmod(path.join(homes[0],'installation_id'),0o600);}
  const before=await Promise.all(homes.map(inventory));
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),accountId:'personal',timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));assert.equal(report.accountId,'personal');assert.deepEqual(report.windows.map(x=>x.usedPercent),[11,11]);
  assert.deepEqual(await Promise.all(homes.map(inventory)),before);
  assert.equal(JSON.stringify(report).includes(root),false);
}));

test('Forbidden child write is rejected and cannot return a successful quota',()=>fixture(async({root,homes})=>{
  const before=await inventory(homes[0]);
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1],'forbidden'),timeoutMs:3000}).observe();
  assert.equal(report.status,'unavailable');assert.equal(report.errorKind,'write_isolation_failed');assert.deepEqual(await inventory(homes[0]),before);
}));

for(const behavior of ['timeout','crash','protocol'])test(`${behavior}: source preserved and scratch cleaned`,()=>fixture(async({root,homes})=>{
  const before=await inventory(homes[0]),prefix=`codex-meter-quota-${process.getuid()}-${process.pid}-`;
  const old=(await scratchEntries()).filter(name=>name.startsWith(prefix));
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1],behavior),timeoutMs:300}).observe();
  assert.equal(report.status,'unavailable');assert.equal(report.errorKind,behavior==='timeout'?'app_server_timeout':behavior==='protocol'?'app_server_unavailable':'write_isolation_failed');
  assert.deepEqual((await scratchEntries()).filter(name=>name.startsWith(prefix)),old);assert.deepEqual(await inventory(homes[0]),before);
}));

test('Negative control: removing confinement makes the same source-inventory assertion fail',()=>fixture(async({root,homes})=>{
  const before=await inventory(homes[0]),command=path.join(root,'negative.cjs');
  await writeFile(command,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'auth.json'),'FORBIDDEN MUTATION');\n`);await chmod(command,0o755);
  await new QuotaReporter({codexHome:homes[0],command,timeoutMs:300}).observe();
  const after=await inventory(homes[0]);
  assert.throws(()=>assert.deepEqual(after,before),assert.AssertionError);
}));

test('Spawn exception cleans allocated scratch without any source changes',()=>fixture(async({root,homes})=>{
  const before=await inventory(homes[0]),prefix=`codex-meter-quota-${process.getuid()}-${process.pid}-`;
  const old=(await scratchEntries()).filter(name=>name.startsWith(prefix));
  const result=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),spawnImpl(){throw new Error('fixture spawn exception');}}).observe();
  assert.equal(result.errorKind,'write_isolation_failed');assert.deepEqual(await inventory(homes[0]),before);assert.deepEqual((await scratchEntries()).filter(name=>name.startsWith(prefix)),old);
}));

test('Stale cleanup removes only old empty owned scratch of dead processes',async()=>{
  await fixture(async({root,homes})=>{const runner=new ExistingHomeQuotaRunner({codexHome:homes[0],command:await fake(root,homes[1])});try{await runner.prepare();}finally{await runner.cleanup();}});
  const prefix=path.join(quotaScratchRoot(),`codex-meter-quota-${process.getuid()}-2147483647-`);
  const empty=await mkdtemp(prefix),nonempty=await mkdtemp(prefix),unmarked=await mkdtemp(prefix),protectedHome=await mkdtemp(prefix),live=await mkdtemp(path.join(quotaScratchRoot(),`codex-meter-quota-${process.getuid()}-${process.pid}-`));
  for(const dir of [empty,nonempty,protectedHome])await writeFile(path.join(dir,'.codex-meter-quota-owner'),`codex-meter-quota-v1:${process.getuid()}:2147483647\n`,{mode:0o600});
  await writeFile(path.join(nonempty,'keep'),'fixture');
  for(const dir of [empty,nonempty,unmarked,protectedHome,live])await utimes(dir,new Date(0),new Date(0));
  try{await reapQuotaScratch({protectedHomes:[protectedHome]});await assert.rejects(lstat(empty),{code:'ENOENT'});for(const dir of [nonempty,unmarked,protectedHome,live])assert.ok(await lstat(dir));}
  finally{for(const dir of [empty,nonempty,unmarked,protectedHome,live])await rm(dir,{recursive:true,force:true});}
});

test('A Home attached after a janitor snapshot is never inspected or removed, even with an old ownership marker',()=>fixture(async({root,homes})=>{
  const selected=await mkdtemp(`/tmp/codex-meter-quota-${process.getuid()}-2147483647-`),marker=path.join(selected,'.codex-meter-quota-owner');
  await writeFile(marker,`codex-meter-quota-v1:${process.getuid()}:2147483647\n`,{mode:0o600});
  await utimes(marker,new Date(0),new Date(0));await utimes(selected,new Date(0),new Date(0));
  const database=openAgentDatabase(path.join(root,'agent.db'));
  try {
    const config=validateConfig({deviceId:'fixture-device',deviceSecret:'fixture-secret-for-local-test-only',serverUrl:'https://meter.invalid',databasePath:path.join(root,'agent.db'),codexHome:homes[0]});
    const profiles=[{accountId:'personal',bindingId:'binding-personal',name:'Personal',mode:'existing',selectionKey:'selection-personal'}];
    await applyDesiredConfiguration(database,config,{schemaVersion:1,revision:1,syncIntervalSeconds:15,heartbeatIntervalSeconds:60,maxBatchSize:100,profiles});
    const inFlightSnapshot=[homes[0]];
    await attachExistingHome(database,config,profiles[0],selected);
    assert.equal(database.prepare('SELECT canonical_home FROM existing_home_selections').get().canonical_home,selected);
    const before=await Promise.all([selected,marker].map(filename=>lstat(filename)));
    await reapQuotaScratch({protectedHomes:inFlightSnapshot});
    assert.deepEqual(await Promise.all([selected,marker].map(filename=>lstat(filename))),before);
  } finally {database.close();await rm(selected,{recursive:true,force:true});}
}));

test('Reserved runtime root cannot become an adopted Home or external config source through direct paths or aliases',()=>fixture(async({root,homes})=>{
  const runner=new ExistingHomeQuotaRunner({codexHome:homes[0],command:await fake(root,homes[1])});
  try {
    await runner.prepare();
    await assert.rejects(validateExistingHome(runner.scratch),/runtime directories/);
    const alias=path.join(root,'runtime-alias');await symlink(runner.scratch,alias);
    await assert.rejects(validateExistingHome(alias),/runtime directories/);
    const direct=new ExistingHomeQuotaRunner({codexHome:runner.scratch,command:process.execPath});
    await assert.rejects(direct.prepare(),{kind:'write_isolation_failed'});
    await rm(path.join(homes[1],'config.toml'));await symlink(path.join(runner.scratch,'.codex-meter-quota-owner'),path.join(homes[1],'config.toml'));
    const other=new ExistingHomeQuotaRunner({codexHome:homes[1],command:process.execPath});let reads=0;
    other.assertFileAuthPolicy=async()=>{reads++;};
    await assert.rejects(other.prepare(),{kind:'write_isolation_failed'});assert.equal(reads,0);
  }finally{await runner.cleanup();}
}));

test('Client restart uses fresh scratch, restores selected context, and releases every runtime',()=>fixture(async({root,homes})=>{
  const before=await inventory(homes[0]),command=await fake(root,homes[1]),scratches=[];
  for(let count=0;count<2;count++){
    const client=new ReadOnlyAppServerClient({readOnlyHome:true,codexHome:homes[0],command,timeoutMs:3000});
    try{await client.start();scratches.push(client.runner.scratch);assert.equal(await client.isAuthenticated(),true);assert.ok(await client.readRateLimits());}finally{await client.close();}
  }
  assert.notEqual(scratches[0],scratches[1]);for(const dir of scratches)await assert.rejects(lstat(dir),{code:'ENOENT'});assert.deepEqual(await inventory(homes[0]),before);
}));

test('Agent death terminates sandbox descendants and leaves only safely reapable empty scratch',()=>fixture(async({root,homes})=>{
  const command=await fake(root,homes[1]),entry=path.join(root,'agent.mjs');
  await writeFile(entry,`import {ReadOnlyAppServerClient} from ${JSON.stringify(new URL('../../v2/agent/app-server.js',import.meta.url).href)};
const client=new ReadOnlyAppServerClient({readOnlyHome:true,codexHome:${JSON.stringify(homes[0])},command:${JSON.stringify(command)},timeoutMs:3000});
await client.start();process.send({pid:client.child.pid,scratch:client.runner.scratch});setInterval(()=>{},1000);`);
  const agent=spawn(process.execPath,[entry],{stdio:['ignore','ignore','ignore','ipc']});
  const data=await new Promise((resolve,reject)=>{agent.once('message',resolve);agent.once('exit',()=>reject(new Error('agent exited before setup')));setTimeout(()=>reject(new Error('agent startup timeout')),5000).unref();});
  const exit=new Promise(resolve=>agent.once('exit',resolve));agent.kill('SIGTERM');await exit;
  let exists=true;
  for(let attempt=0;attempt<40;attempt++){try{await lstat(`/proc/${data.pid}`);}catch{exists=false;break;}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(exists,false,'sandbox process must be reaped; run container with --init');
  assert.deepEqual(await readdir(data.scratch),['.codex-meter-quota-owner']);await utimes(data.scratch,new Date(0),new Date(0));await reapQuotaScratch();await assert.rejects(lstat(data.scratch),{code:'ENOENT'});
}));

test('Concurrent accounts use separate contexts and preserve both source Homes',()=>fixture(async({root,homes})=>{
  const before=await Promise.all(homes.map(inventory));
  const commands=[await fake(path.join(root),homes[1],'account-a'),await fake(path.join(root),homes[0],'account-b')];
  const reports=await Promise.all(homes.map((home,index)=>new QuotaReporter({readOnlyHome:true,codexHome:home,command:commands[index],accountId:`account-${index}`,timeoutMs:3000}).observe()));
  assert.deepEqual(reports.map(report=>[report.accountId,report.status,report.windows[0]?.usedPercent]),[['account-0','available',11],['account-1','available',77]]);
  assert.deepEqual(await Promise.all(homes.map(inventory)),before);
}));

test('Shared config symlink target is read-only and configuration remains effective',()=>fixture(async({root,homes})=>{
  const shared=path.join(root,'shared-config.toml');await writeFile(shared,'fixture_account = 1\n');await rm(path.join(homes[0],'config.toml'));await symlink(shared,path.join(homes[0],'config.toml'));
  const before=await inventory(homes[0]),metadata=await lstat(shared);
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));assert.equal(report.windows[0].usedPercent,11);assert.deepEqual(await inventory(homes[0]),before);assert.equal((await lstat(shared)).mtimeMs,metadata.mtimeMs);
}));

test('Rejected intermediate config symlink does not change source atime',()=>fixture(async({root,homes})=>{
  const shared=path.join(root,'shared');await mkdir(shared);await writeFile(path.join(shared,'config.toml'),'fixture_account = 1\n');
  const linked=path.join(homes[0],'linked'),config=path.join(homes[0],'config.toml');
  await symlink(shared,linked);await rm(config);await symlink('linked/config.toml',config);
  for(const filename of [linked,config])await lutimes(filename,new Date(0),new Date(0));
  const before=await Promise.all([linked,config].map(filename=>lstat(filename)));
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),timeoutMs:3000}).observe();
  assert.equal(report.errorKind,'write_isolation_failed');assert.deepEqual(await Promise.all([linked,config].map(filename=>lstat(filename))),before);
}));

test('Rejected Home root symlink is never resolved and preserves its metadata',()=>fixture(async({root,homes})=>{
  const linked=path.join(root,'linked-home');await symlink(homes[0],linked);await lutimes(linked,new Date(0),new Date(0));
  const before=await lstat(linked);
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:linked,command:await fake(root,homes[1]),timeoutMs:3000}).observe();
  assert.equal(report.errorKind,'write_isolation_failed');assert.deepEqual(await lstat(linked),before);
}));

test('Executable resolution protects links inside and reentering the selected Home',()=>fixture(async({root,homes})=>{
  const inside=path.join(homes[0],'codex'),outside=path.join(root,'codex-alias');
  await symlink(await fake(root,homes[1]),inside);await symlink(inside,outside);
  for(const command of [inside,outside]){
    await lutimes(inside,new Date(0),new Date(0));await lutimes(outside,new Date(0),new Date(0));
    const before=await Promise.all([inside,outside].map(filename=>lstat(filename)));
    const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command,timeoutMs:3000}).observe();
    assert.equal(report.status,command===inside?'unavailable':'available',JSON.stringify(report));assert.deepEqual(await Promise.all([inside,outside].map(filename=>lstat(filename))),before);
  }
}));

test('Ordinary executable symlink lookup remains supported and read-only',()=>fixture(async({root,homes})=>{
  const command=path.join(root,'codex-alias');await symlink(await fake(root,homes[1]),command);await lutimes(command,new Date(0),new Date(0));
  const before=await lstat(command);
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command,timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));assert.deepEqual(await lstat(command),before);
}));

test('A config link requiring a collapsed intermediate directory fails closed, never defaults',()=>fixture(async({root,homes})=>{
  const config=path.join(homes[0],'config.toml');await mkdir(path.join(homes[0],'subdir'));await writeFile(path.join(root,'shared.toml'),'fixture_account = 1\n');
  await rm(config);await symlink('subdir/../../shared.toml',config);assert.equal(await readFile(config,'utf8'),'fixture_account = 1\n');
  await lutimes(config,new Date(0),new Date(0));const before=await lstat(config);
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),timeoutMs:3000}).observe();
  assert.equal(report.errorKind,'write_isolation_failed');assert.deepEqual(await lstat(config),before);
}));

test('Child auth/config reads through protected mounts preserve even aged file atime',()=>fixture(async({root,homes})=>{
  const inputs=['auth.json','config.toml'].map(name=>path.join(homes[0],name));
  for(const input of inputs)await utimes(input,new Date(0),new Date(0));
  const before=await Promise.all(inputs.map(input=>lstat(input)));
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));assert.deepEqual(await Promise.all(inputs.map(input=>lstat(input))),before);
}));

test('All system configuration layers remain visible and read-only, never silently defaulted',()=>fixture(async({root,homes})=>{
  assert.equal(process.env.CODEX_METER_FIXTURE_SYSTEM_CONFIG,'1','Mount the supplied synthetic system fixture; never use real system config');
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1],'system-config'),timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));
}));

test('User-prefix npm launcher resolves a sibling platform package inside the protected runtime',()=>fixture(async({root,homes})=>{
  const scope=path.join(root,'prefix','node_modules','@openai'),pkg=path.join(scope,'codex'),dependency=path.join(scope,`codex-linux-${process.arch}`);
  await mkdir(path.join(pkg,'bin'),{recursive:true});await mkdir(dependency,{recursive:true});
  await writeFile(path.join(dependency,'package.json'),JSON.stringify({name:`@openai/codex-linux-${process.arch}`}));
  const native=path.join(dependency,'native.cjs');await copyFile(await fake(root,homes[1]),native);await chmod(native,0o755);
  const command=path.join(pkg,'bin','codex.js');
  await writeFile(command,`#!/usr/bin/env node\nconst path=require('node:path'),{spawn}=require('node:child_process');const dependency=path.dirname(require.resolve('@openai/codex-linux-${process.arch}/package.json'));const child=spawn(path.join(dependency,'native.cjs'),process.argv.slice(2),{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));\n`);await chmod(command,0o755);
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command,timeoutMs:3000}).observe();
  assert.equal(report.status,'available',JSON.stringify(report));assert.equal(report.windows[0].usedPercent,11);
}));

test('Quota never janitor-probes another retained Home, even with an old scratch name and marker',()=>fixture(async({root,homes})=>{
  const other=await mkdtemp(`/tmp/codex-meter-quota-${process.getuid()}-2147483647-`),marker=path.join(other,'.codex-meter-quota-owner');
  await writeFile(marker,`codex-meter-quota-v1:${process.getuid()}:2147483647\n`,{mode:0o600});
  await writeFile(path.join(other,'config.toml'),'# synthetic selected Home');
  await utimes(marker,new Date(0),new Date(0));await utimes(other,new Date(0),new Date(0));
  const before=await Promise.all([other,marker].map(filename=>lstat(filename)));
  try{
    const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,other),isolationOptions:{protectedHomes:[homes[0],other]},timeoutMs:3000}).observe();
    assert.equal(report.status,'available',JSON.stringify(report));assert.deepEqual(await Promise.all([other,marker].map(filename=>lstat(filename))),before);
  }finally{await rm(other,{recursive:true,force:true});}
}));

test('Janitor inspection cannot mutate nonempty scratch subsequently used as an external source',async()=>{
  const directory=await mkdtemp(`/tmp/codex-meter-quota-${process.getuid()}-2147483647-`),marker=path.join(directory,'.codex-meter-quota-owner');
  await writeFile(marker,`codex-meter-quota-v1:${process.getuid()}:2147483647\n`,{mode:0o600});await writeFile(path.join(directory,'shared.toml'),'# synthetic external source');
  await utimes(marker,new Date(0),new Date(0));await utimes(directory,new Date(0),new Date(0));
  const before=await Promise.all([directory,marker].map(filename=>lstat(filename)));
  try{await reapQuotaScratch();assert.deepEqual(await Promise.all([directory,marker].map(filename=>lstat(filename))),before);}
  finally{await rm(directory,{recursive:true,force:true});}
});

for(const store of ['auto','keyring','ephemeral'])test(`Unsupported ${store} storage never launches an auth-capable Codex child or falls back to stale file auth`,()=>fixture(async({root,homes})=>{
  const config=path.join(homes[0],'config.toml');await writeFile(config,`cli_auth_credentials_store = "${store}"\n`);await utimes(config,new Date(0),new Date(0));
  const before=await lstat(config);let launches=0;
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1]),spawnImpl(){launches++;throw Error('must not launch auth-capable child');},timeoutMs:3000}).observe();
  assert.equal(report.errorKind,'write_isolation_failed');assert.equal(launches,0);assert.deepEqual(await lstat(config),before);
}));

test('Effective managed auth-store requirements are checked before any account/quota RPC',()=>fixture(async({root,homes})=>{
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:homes[0],command:await fake(root,homes[1],'managed-auto'),timeoutMs:3000}).observe();
  assert.equal(report.errorKind,'write_isolation_failed');
}));

test('A config hardlink to auth is rejected before any TOML policy content inspection',()=>fixture(async({root,homes})=>{
  const config=path.join(homes[0],'config.toml');await rm(config);await link(path.join(homes[0],'auth.json'),config);
  const runner=new ExistingHomeQuotaRunner({codexHome:homes[0],command:await fake(root,homes[1])});let inspections=0;
  runner.assertFileAuthPolicy=async()=>{inspections++;throw Error('must not read an auth alias');};
  try{await assert.rejects(runner.prepare(),{kind:'write_isolation_failed'});assert.equal(inspections,0);}
  finally{await runner.cleanup();}
}));

test('A config symlink to another Home auth file is rejected before any policy content read',()=>fixture(async({root,homes})=>{
  const config=path.join(homes[0],'config.toml');await rm(config);await symlink(path.join(homes[1],'auth.json'),config);
  const runner=new ExistingHomeQuotaRunner({codexHome:homes[0],command:await fake(root,homes[1])});let inspections=0;
  runner.assertFileAuthPolicy=async()=>{inspections++;throw Error('must not read other credentials');};
  try{await assert.rejects(runner.prepare(),{kind:'write_isolation_failed'});assert.equal(inspections,0);}
  finally{await runner.cleanup();}
}));

test('Policy hardlinks to other credentials are rejected even when the alias has a TOML name',()=>fixture(async({root,homes})=>{
  const config=path.join(homes[0],'config.toml');await rm(config);await link(path.join(homes[1],'auth.json'),config);
  const runner=new ExistingHomeQuotaRunner({codexHome:homes[0],command:await fake(root,homes[1])});let inspections=0;
  runner.assertFileAuthPolicy=async()=>{inspections++;throw Error('must not read other credential aliases');};
  try{await assert.rejects(runner.prepare(),{kind:'write_isolation_failed'});assert.equal(inspections,0);}
  finally{await runner.cleanup();}
}));
