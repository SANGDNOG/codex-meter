import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { AgentCollector } from '../v2/agent/collector.js';
import { AgentRuntime } from '../v2/agent/runtime.js';
import { openAgentDatabase } from '../v2/agent/database.js';
import { validateConfig } from '../v2/agent/config.js';
import { discoverExistingRollouts, validateExistingHome } from '../v2/agent/existing-home.js';
import { ExistingReadBoundary, discoverGuardedRollouts } from '../v2/agent/existing-rollouts.js';
import { discoverRollouts } from '../v2/agent/discovery.js';
import { existingRootKey, readExistingRoot } from '../v2/agent/existing-root.js';
import { assertExistingQuotaLocation } from '../v2/agent/existing-quota-runner.js';

const session='11111111-1111-4111-8111-111111111111';
const future=new Date(Date.now()+60000).toISOString();
const usage=tokens=>`${JSON.stringify({timestamp:future,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:tokens,total_tokens:tokens}}}})}\n`;
const rollout=tokens=>`${JSON.stringify({type:'session_meta',payload:{id:session,source:'cli'}})}\n${usage(tokens)}`;
const dbSnapshot=db=>({cursors:db.prepare('SELECT * FROM rollout_cursors ORDER BY rollout_key').all(),state:db.prepare('SELECT * FROM agent_state ORDER BY key').all(),outbox:db.prepare('SELECT * FROM usage_outbox ORDER BY event_id').all()});
const totals=db=>db.prepare('SELECT account_id,sum(total_tokens) total FROM usage_outbox GROUP BY account_id ORDER BY account_id').all().map(row=>({...row}));

async function fixture(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'meter-collector-isolation-'));
  const homes=[path.join(root,'codex'),path.join(root,'codex-evil')];
  const databasePath=path.join(root,'agent.db');let database=openAgentDatabase(databasePath);
  for(const home of homes){
    await mkdir(path.join(home,'sessions','nested'),{recursive:true});
    await writeFile(path.join(home,'config.toml'),'# synthetic untouched configuration');
    await writeFile(path.join(home,'auth.json'),'SYNTHETIC AUTH SENTINEL - NOT A CREDENTIAL');
  }
  const files=homes.map(home=>path.join(home,'sessions','nested',`rollout-${session}.jsonl`));
  await writeFile(files[1],rollout(777));
  const config=validateConfig({deviceId:'device-fixture',deviceSecret:'collector-fixture-secret-not-real',serverUrl:'https://meter.invalid',databasePath,codexHome:homes[0]});
  const make=(index=0,hook)=>new AgentCollector(database,{home:homes[index],accountId:index?'account-b':'account-a',bindingKey:index?'binding-b':'binding-a',discovery:options=>discoverExistingRollouts({...options,hook})});
  try{await run({root,homes,files,database,config,make,restart(){database.close();database=openAgentDatabase(databasePath);return database;}});}
  finally{database.close();await rm(root,{recursive:true,force:true});}
}

async function swap(directory,target){const saved=`${directory}.saved`;await rename(directory,saved);await symlink(target,directory,'junction');return async()=>{await rm(directory);await rename(saved,directory);};}

test('Negative control: legacy validation followed by pathname discovery reproduces the original 777-token misattribution',()=>fixture(async({homes,database})=>{
  const legacy=new AgentCollector(database,{home:homes[0],accountId:'account-a',bindingKey:'binding-a',discovery:async options=>{await validateExistingHome(options.home);return discoverRollouts(options);}});
  await legacy.baselineCurrent();const original=fsPromises.opendir;let hit=false,restore;
  fsPromises.opendir=async(filename,...args)=>{if(!hit&&filename===path.join(homes[0],'sessions')){hit=true;restore=await swap(filename,path.join(homes[1],'sessions'));}return original(filename,...args);};syncBuiltinESMExports();
  try{await legacy.reconcile();assert.equal(hit,true);assert.deepEqual(totals(database),[{account_id:'account-a',total:777}]);}
  finally{fsPromises.opendir=original;syncBuiltinESMExports();await restore?.();}
}));

test('Original 777-token reproduction: swap sessions immediately after validation, discard all state, restore and retry',()=>fixture(async({homes,files,database,make})=>{
  await make().baselineCurrent();const before=dbSnapshot(database);let restore,hit=false;
  const collector=make(0,async(stage,{path:filename})=>{if(!hit&&stage==='before-directory-open'&&filename===path.join(homes[0],'sessions')){hit=true;restore=await swap(filename,path.join(homes[1],'sessions'));}});
  try{await assert.rejects(collector.reconcile());assert.equal(hit,true);assert.deepEqual(dbSnapshot(database),before);assert.deepEqual(totals(database),[]);}
  finally{await restore?.();}
  await writeFile(files[0],rollout(25));await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
}));

for(const phase of ['after-validation','before-reconciliation','after-restart'])test(`Real Home B directory moved onto A at ${phase} cannot replace the persisted selected root`,()=>fixture(async({homes,files,database,make,restart})=>{
  await make().baselineCurrent();const expected=readExistingRoot(database,'binding-a',homes[0]);assert.ok(expected);
  let current=database;const before=dbSnapshot(current),saved=`${homes[0]}.saved`;let moved=false;
  const move=async()=>{await rename(homes[0],saved);await rename(homes[1],homes[0]);moved=true;};
  const original=fsPromises.lstat;let rootChecks=0;
  if(phase==='after-validation'){
    fsPromises.lstat=async(filename,...options)=>{if(filename===homes[0]&&options[0]?.bigint&&++rootChecks===2)await move();return original(filename,...options);};syncBuiltinESMExports();
  }else{await move();if(phase==='after-restart')current=restart();}
  try{
    await assert.rejects(make().reconcile());assert.equal(moved,true);assert.deepEqual(dbSnapshot(current),before);
    await assert.rejects(assertExistingQuotaLocation(homes[0],expected),{kind:'write_isolation_failed'});
  }finally{fsPromises.lstat=original;syncBuiltinESMExports();if(moved){await rename(homes[0],homes[1]);await rename(saved,homes[0]);}}
  await writeFile(files[0],rollout(25));await make().reconcile();assert.deepEqual(totals(current),[{account_id:'account-a',total:25}]);
}));

test('A bound collector never re-acquires a missing legacy root identity automatically',()=>fixture(async({homes,files,database,make})=>{
  await make().baselineCurrent();database.prepare('DELETE FROM agent_state WHERE key=?').run(existingRootKey('binding-a'));
  await writeFile(files[0],rollout(777));const before=dbSnapshot(database);
  await assert.rejects(make().reconcile(),{code:'EXISTING_READ_ISOLATION'});assert.deepEqual(dbSnapshot(database),before);
  await make().baselineCurrent();await appendFile(files[0],usage(25));await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
}));

test('Recycled dev/inode with a different creation identity is rejected after restart, including quota',()=>fixture(async({homes,files,database,make,restart})=>{
  await make().baselineCurrent();const saved=readExistingRoot(database,'binding-a',homes[0]);
  // Deterministically model the persisted previous generation. The live root
  // retains exactly the same device/inode; no inode allocator timing is needed.
  saved.birthtimeNs=String(BigInt(saved.birthtimeNs)-1n);
  database.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(saved),existingRootKey('binding-a'));
  await writeFile(files[0],rollout(777));const before=dbSnapshot(database),current=restart();
  await assert.rejects(make().reconcile(),{code:'EXISTING_READ_ISOLATION'});
  await assert.rejects(assertExistingQuotaLocation(homes[0],saved),{kind:'write_isolation_failed'});
  assert.deepEqual(dbSnapshot(current),before);assert.deepEqual(totals(current),[]);
}));

test('Old saved dev/inode without creation identity requires explicit selection, not automatic trust',()=>fixture(async({homes,files,database,make})=>{
  await make().baselineCurrent();const old=readExistingRoot(database,'binding-a',homes[0]);delete old.birthtimeNs;
  database.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(old),existingRootKey('binding-a'));
  await writeFile(files[0],rollout(777));const before=dbSnapshot(database);
  assert.equal(readExistingRoot(database,'binding-a',homes[0]),null);
  await assert.rejects(make().reconcile(),{code:'EXISTING_READ_ISOLATION'});assert.deepEqual(dbSnapshot(database),before);
  await make().baselineCurrent();await appendFile(files[0],usage(25));await make().reconcile();
  assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
}));

test('Filesystem without a usable root creation identity fails closed at validation and guarded discovery',()=>fixture(async({homes})=>{
  const oldStat=fsPromises.stat,oldLstat=fsPromises.lstat;
  const wrap=original=>async(filename,...args)=>{const info=await original(filename,...args);if(filename===homes[0]&&args[0]?.bigint)info.birthtimeNs=0n;return info;};
  fsPromises.stat=wrap(oldStat);fsPromises.lstat=wrap(oldLstat);syncBuiltinESMExports();
  try{await assert.rejects(validateExistingHome(homes[0]));await assert.rejects(discoverGuardedRollouts({home:homes[0]}),{code:'EXISTING_READ_ISOLATION'});}
  finally{fsPromises.stat=oldStat;fsPromises.lstat=oldLstat;syncBuiltinESMExports();}
}));

for(const phase of ['after-read','before-commit'])test(`Growth followed by shrink at ${phase} discards events and cursor beyond final EOF`,()=>fixture(async({files,database,make})=>{
  await writeFile(files[0],rollout(100));await make().baselineCurrent();await appendFile(files[0],usage(25));
  const initial=(await lstat(files[0])).size,before=dbSnapshot(database);let grew=false,shrank=false;
  await assert.rejects(make(0,async(stage)=>{
    if(!grew&&stage==='before-file-open'){grew=true;await appendFile(files[0],usage(9));}
    if(grew&&!shrank&&stage===phase){shrank=true;await truncate(files[0],initial);}
  }).reconcile());
  assert.equal(grew,true);assert.equal(shrank,true);assert.deepEqual(dbSnapshot(database),before);
  await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
}));

for(const stage of ['after-validation','before-directory-open','after-directory-open','before-file-open','after-file-open','before-read','during-read','after-read','before-commit']){
  test(`Directory replacement at ${stage} cannot advance cursors or upload another account`,()=>fixture(async({homes,files,database,make})=>{
    await writeFile(files[0],rollout(100));await make().baselineCurrent();await appendFile(files[0],usage(25));
    const before=dbSnapshot(database);let hit=false,restore;
    const collector=make(0,async(current)=>{if(!hit&&current===stage){hit=true;restore=await swap(path.join(homes[0],'sessions'),path.join(homes[1],'sessions'));}});
    try{await assert.rejects(collector.reconcile());assert.equal(hit,true);assert.deepEqual(dbSnapshot(database),before);}
    finally{await restore?.();}
    await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
  }));
}

for(const stage of ['after-file-open','before-read','during-read','after-read','before-commit'])test(`Swap and restore at ${stage} still rejects the whole read via directory change identity`,()=>fixture(async({homes,files,database,make})=>{
  await writeFile(files[0],rollout(100));await make().baselineCurrent();await appendFile(files[0],usage(25));const before=dbSnapshot(database);let hit=false;
  await assert.rejects(make(0,async(current)=>{if(!hit&&current===stage){hit=true;const restore=await swap(path.join(homes[0],'sessions','nested'),path.join(homes[1],'sessions','nested'));await restore();}}).reconcile());
  assert.equal(hit,true);assert.deepEqual(dbSnapshot(database),before);await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
}));

for(const stage of ['before-file-open','after-file-open'])for(const symlinked of [false,true])test(`Final file ${symlinked?'symlink':'replacement'} at ${stage} cannot substitute 777 tokens`,()=>fixture(async({files,database,make})=>{
  await writeFile(files[0],rollout(100));await make().baselineCurrent();await appendFile(files[0],usage(25));const before=dbSnapshot(database);let hit=false;
  const saved=`${files[0]}.saved`;
  try{
    await assert.rejects(make(0,async(current)=>{if(!hit&&current===stage){hit=true;await rename(files[0],saved);if(symlinked)await symlink(files[1],files[0],'file');else await writeFile(files[0],rollout(777));}}).reconcile());
    assert.equal(hit,true);assert.deepEqual(dbSnapshot(database),before);
  }finally{if(hit){await rm(files[0]);await rename(saved,files[0]);}}
  await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
}));

test('A later-file race discards earlier parsed events and compressed-baseline changes atomically',()=>fixture(async({homes,files,database,make})=>{
  await make().baselineCurrent();await writeFile(files[0],rollout(25));
  const second=path.join(path.dirname(files[0]),'rollout-22222222-2222-4222-8222-222222222222.jsonl');await writeFile(second,rollout(9));
  await writeFile(`${second}.zst`,'synthetic compressed baseline');
  const before=dbSnapshot(database);let hit=false,restore;
  try{
    await assert.rejects(make(0,async(stage,{path:filename})=>{if(!hit&&stage==='after-read'&&filename===second){hit=true;restore=await swap(path.join(homes[0],'sessions'),path.join(homes[1],'sessions'));}}).reconcile());
    assert.equal(hit,true);assert.deepEqual(dbSnapshot(database),before);
  }finally{await restore?.();}
}));

test('First attach baseline is never committed when a read races',()=>fixture(async({homes,files,database,make})=>{
  await writeFile(files[0],rollout(100));const before=dbSnapshot(database);let restore,hit=false;
  try{await assert.rejects(make(0,async(stage)=>{if(!hit&&stage==='after-read'){hit=true;restore=await swap(path.join(homes[0],'sessions'),path.join(homes[1],'sessions'));}}).baselineCurrent());assert.deepEqual(dbSnapshot(database),before);}
  finally{await restore?.();}
  await make().baselineCurrent();await appendFile(files[0],usage(25));await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
}));

test('Canonical Home alias is accepted; nested/final links and root-prefix collisions cannot import B',()=>fixture(async({root,homes,files,database,make})=>{
  const alias=path.join(root,'home-alias');await symlink(homes[0],alias,'junction');assert.equal(await validateExistingHome(alias),homes[0]);
  await make().baselineCurrent();await symlink(path.join(homes[1],'sessions'),path.join(homes[0],'sessions','outside'),'junction');await symlink(files[1],files[0],'file');
  await make().reconcile();assert.deepEqual(totals(database),[]);
  await assert.rejects(validateExistingHome(alias,[homes[0]]),/overlaps/);
  await assert.rejects(validateExistingHome(path.dirname(homes[0]),[homes[0]]),/overlaps/);
  assert.equal(await validateExistingHome(homes[1],[homes[0]]),homes[1]);
}));

test('Hardlinked rollout shared with another Home fails closed',()=>fixture(async({files,database,make})=>{
  await make().baselineCurrent();await link(files[1],files[0]);const before=dbSnapshot(database);await assert.rejects(make().reconcile());assert.deepEqual(dbSnapshot(database),before);
}));

test('Watch notification is only a hint: race rejection preserves A, B, and restored restart attribution',()=>fixture(async({homes,files,database,config,make,restart})=>{
  await writeFile(files[0],rollout(100));await make().baselineCurrent();await make(1).baselineCurrent();await appendFile(files[0],usage(25));
  let restore,hit=false,syncs=0;
  const collector=make(0,async(stage)=>{if(!hit&&stage==='before-file-open'){hit=true;restore=await swap(path.join(homes[0],'sessions'),path.join(homes[1],'sessions'));}});
  const runtime=new AgentRuntime(database,config,{fixedCollectors:true,collectors:[collector,make(1)],syncClient:{async sync(){syncs++;}}});runtime.running=true;
  const positions=()=>database.prepare('SELECT * FROM rollout_cursors ORDER BY rollout_key').all().map(({updated_at,...row})=>row);
  const before=positions();
  try{await runtime.trigger();assert.equal(hit,true);assert.equal(syncs,0);assert.deepEqual(totals(database),[]);assert.deepEqual(positions(),before);}
  finally{await runtime.stop();await restore?.();}
  const reopened=restart();await appendFile(files[1],usage(9));await make().reconcile();await make(1).reconcile();
  assert.deepEqual(totals(reopened),[{account_id:'account-a',total:25},{account_id:'account-b',total:9}]);
}));

for(const platform of ['win32','darwin'])test(`${platform} portable handle route: stable reads succeed, reparse/canonical escape and swap-and-restore reject`,()=>fixture(async({homes,files,database,make})=>{
  await writeFile(files[0],rollout(100));await make().baselineCurrent();await appendFile(files[0],usage(25));
  const original=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{value:platform});
  const guarded=hook=>new AgentCollector(database,{home:homes[0],accountId:'account-a',bindingKey:'binding-a',discovery:options=>discoverGuardedRollouts({...options,hook})});
  try{
    let hit=false;const before=dbSnapshot(database);
    await assert.rejects(guarded(async(stage)=>{if(!hit&&stage==='after-file-open'){hit=true;const restore=await swap(path.join(homes[0],'sessions'),path.join(homes[1],'sessions'));await restore();}}).reconcile());
    assert.equal(hit,true);assert.deepEqual(dbSnapshot(database),before);
    const restore=await swap(path.join(homes[0],'sessions'),path.join(homes[1],'sessions'));
    try{await assert.rejects(guarded().reconcile());assert.deepEqual(dbSnapshot(database),before);}finally{await restore();}
    await guarded().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:25}]);
  }finally{Object.defineProperty(process,'platform',original);}
}));

test('Unreliable zero file IDs fail closed before content reads',()=>fixture(async({homes})=>{
  const boundary=new ExistingReadBoundary(homes[0]);const original=fsPromises.lstat;
  fsPromises.lstat=async(...args)=>{const info=await original(...args);if(args[1]?.bigint)info.ino=0n;return info;};syncBuiltinESMExports();
  try{await assert.rejects(boundary.initialize(),{code:'EXISTING_READ_ISOLATION'});}finally{fsPromises.lstat=original;syncBuiltinESMExports();await boundary.close();}
}));

test('Discovery validates only the current branch per directory and remains linear for growing archives',()=>fixture(async({homes})=>{
  const count=100;
  for(let index=0;index<count;index++){
    const directory=path.join(homes[0],'sessions',`day-${index}`);await mkdir(directory);
    await writeFile(path.join(directory,'rollout.jsonl'),'{}\n');
  }
  const original=fsPromises.lstat;let calls=0,found;
  fsPromises.lstat=async(...args)=>{calls++;return original(...args);};syncBuiltinESMExports();
  try{
    found=await discoverExistingRollouts({home:homes[0]});assert.equal(found.files.length,count);
    await found.validate();assert.ok(calls<30*(count+1),`unbounded repeated metadata validation: ${calls} calls`);
  }finally{fsPromises.lstat=original;syncBuiltinESMExports();await found?.close();}
}));

test('Ordinary appends during every file read do not starve the unchanged rollouts or lose/duplicate the growing stream',()=>fixture(async({files,database,make})=>{
  await make().baselineCurrent();await writeFile(files[0],rollout(1));
  for(let index=1;index<100;index++)await writeFile(path.join(path.dirname(files[0]),`rollout-22222222-2222-4222-8222-${String(index).padStart(12,'0')}.jsonl`),rollout(1));
  const appended=new Set();
  await make(0,async(stage,{path:filename})=>{if(stage==='during-read'&&!appended.has(filename)){appended.add(filename);await appendFile(files[0],usage(1));}}).reconcile();
  assert.equal(appended.size,100);assert.deepEqual(totals(database),[{account_id:'account-a',total:101}]);
  await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:200}]);
  await make().reconcile();assert.deepEqual(totals(database),[{account_id:'account-a',total:200}]);
}));

test('Stable collection leaves adopted config/auth/launcher and session bytes unchanged, and wire events contain no paths',()=>fixture(async({root,homes,files,database,make})=>{
  await writeFile(files[0],rollout(100));const launcher=path.join(root,'cx1');await writeFile(launcher,'synthetic existing launcher');
  const names=[path.join(homes[0],'config.toml'),path.join(homes[0],'auth.json'),files[0],launcher];
  const before=await Promise.all(names.map(name=>readFile(name)));await make().baselineCurrent();await make().reconcile();
  assert.deepEqual(await Promise.all(names.map(name=>readFile(name))),before);assert.equal((await readdir(homes[0])).includes('.codex-meter-profile.json'),false);
  await appendFile(files[0],usage(25));await make().reconcile();assert.equal(JSON.stringify(database.prepare('SELECT * FROM usage_outbox').all()).includes(root),false);
}));
