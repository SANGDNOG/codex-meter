import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, lutimes, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { QuotaReporter, ReadOnlyAppServerClient } from '../v2/agent/app-server.js';
import { EventEmitter } from 'node:events';
import { AgentSyncClient } from '../v2/agent/sync.js';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meter-isolation-unit-'));
  const home = path.join(root, 'selected'); await mkdir(home);
  try { await run({ root, home }); } finally { await rm(root, { recursive:true, force:true }); }
}

test('Existing quota fails closed on unverified macOS and Windows adapters without starting Codex', async () => {
  for (const platform of ['darwin', 'win32']) {
    let launches = 0;
    const report = await new QuotaReporter({readOnlyHome:true,codexHome:platform==='win32'?'C:\\Users\\Person\\Existing':'/Users/person/Existing',isolationOptions:{platform},spawnImpl(){launches++;throw new Error('must not launch');}}).observe();
    assert.equal(report.status,'unavailable');assert.equal(report.errorKind,'write_isolation_failed');assert.equal(launches,0);
  }
});

test('Missing isolation dependency cannot retry Codex against a writable existing Home', () => fixture(async ({home}) => {
  let launches=0;
  const report=await new QuotaReporter({readOnlyHome:true,codexHome:home,isolationOptions:{sandboxCommand:'/nonexistent-meter-bwrap'},spawnImpl(){launches++;throw new Error('must not launch');}}).observe();
  assert.equal(report.errorKind,'write_isolation_failed');assert.equal(launches,0);assert.deepEqual(await readdir(home),[]);
}));

test('Default and managed isolated quota do not select the existing-home adapter', async () => {
  for(const readOnlyHome of [false,undefined]){
    let launches=0;
    const report=await new QuotaReporter({readOnlyHome,command:'fixture-codex',spawnImpl(command){assert.equal(command,'fixture-codex');launches++;throw Object.assign(new Error('missing fixture'),{code:'ENOENT'});}}).observe();
    assert.equal(report.errorKind,'codex_not_found');assert.equal(launches,1);
  }
});

test('Isolation failures return only a safe reason, never source/scratch paths or inherited secrets',()=>fixture(async({home})=>{
  const report=await new QuotaReporter({accountId:'personal',readOnlyHome:true,codexHome:home,isolationOptions:{platform:'unsupported'}}).observe();
  assert.deepEqual(Object.keys(report).sort(),['accountId','errorKind','observedAt','planType','status','windows']);
  assert.equal(JSON.stringify(report).includes(home),false);assert.equal(report.accountId,'personal');
}));

test('Agent quota preflight rejects a replaced root without following it or changing link metadata',()=>fixture(async({root,home})=>{
  const linked=path.join(root,'replaced');await symlink(home,linked);await lutimes(linked,new Date(0),new Date(0));
  const before=await lstat(linked);let probes=0;
  const client={clock:Date.now,quotaReporterFactory:()=>({async observe(){probes++;throw new Error('must not probe rejected root');}})};
  AgentSyncClient.prototype.configureProfiles.call(client,[{accountId:'personal',mode:'existing',localHome:linked}]);
  const report=await client.profileQuotaReporters[0].observe();
  assert.deepEqual(await lstat(linked),before);assert.equal(probes,0);assert.equal(report.status,'unavailable');assert.equal(report.errorKind,'write_isolation_failed');
}));

for(const killWorks of [true,false])test(`Kill fallback requires confirmed child termination: ${killWorks?'reaped':'unconfirmed fails closed'}`,async()=>{
  const keepAlive=setInterval(()=>{},1000),signals=[];let cleaned=false;
  const client=new ReadOnlyAppServerClient(),child=new EventEmitter();
  child.stdin={end(){}};child.exitCode=null;child.signalCode=null;
  child.kill=signal=>{signals.push(signal);if(signal==='SIGKILL'&&killWorks){child.signalCode=signal;child.emit('exit',null,signal);}return killWorks;};
  client.child=child;client.runner={async cleanup(){cleaned=true;}};
  try{
    if(killWorks)await client.close();else await assert.rejects(client.close(),{kind:'write_isolation_failed'});
    assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(cleaned,true);assert.equal(child.listenerCount('exit'),0);
  }finally{clearInterval(keepAlive);}
});

// Enforcement success is a separate mandatory-capability integration command:
// node --test tools/quota-isolation/verify.mjs. It NEVER accepts unavailable as
// successful enforcement. These portable tests deliberately assert fail-closed.
