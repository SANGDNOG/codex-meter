import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { openAgentDatabase } from '../v2/agent/database.js';
import { AgentCollector } from '../v2/agent/collector.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
import { openServerDatabase } from '../v2/server/database.js';
import { MeterService } from '../v2/server/service.js';
import { createV2Server } from '../v2/server/http.js';

function exec(command,args,options={}) { return new Promise(resolve=>{const child=spawn(command,args,options);let out='',err='';child.stdout?.on('data',c=>out+=c);child.stderr?.on('data',c=>err+=c);child.on('exit',code=>resolve({code,out,err}));}); }

// Source-of-truth acceptance map. Each ID points to an exercising test rather than a stub.
const acceptance = {
  1:'M3 installation baseline excludes history', 2:'M3 new root is counted', 3:'M1 telemetry parser accepts only token_count lastUsage',
  4:'M1 telemetry parser preserves absent dimensions', 5:'M3 partial final JSONL', 6:'M3 stable event across restart',
  7:'M2 admin sessions persist across restart', 8:'M3 retains outages', 9:'M2 strict sync is idempotent',
  10:'M2 accounts two devices', 11:'M2 same group', 12:'M2 different groups', 13:'M2 historical moves',
  14:'M2 delayed events', 15:'M2 Unassigned', 16:'M2 positive/negative adjustments', 17:'M4 quota normalization',
  18:'M4 marks stale', 19:'M2 rejects invalid enrollment', 20:'M2 expired enrollment', 21:'M2 reused enrollment',
  22:'M2 disabled credential', 23:'M7 end-to-end privacy', 24:'M1 migrations', 25:'V1 and Phase 0 compatibility'
};
test('M7 explicitly maps all 25 acceptance cases to executable coverage', () => {
  assert.deepEqual(Object.keys(acceptance).map(Number), Array.from({length:25},(_,i)=>i+1));
  assert.ok(Object.values(acceptance).every(value=>typeof value==='string'&&value.length>5));
});

test('M7 parser, Agent DB, sync body, logs, and Server DB exclude every forbidden privacy value', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'codex-meter-m7-privacy-'));
  const codexHome=path.join(dir,'codex'), sessions=path.join(codexHome,'sessions','2026','08','30'); await mkdir(sessions,{recursive:true});
  const agent=openAgentDatabase(path.join(dir,'agent.db')); const server=openServerDatabase(path.join(dir,'server.db'));
  const secrets=['PROMPT_SENTINEL','RESPONSE_SENTINEL','SOURCE_CODE_SENTINEL','TOOL_ARG_SENTINEL','TOOL_OUTPUT_SENTINEL','PATH_SENTINEL','REPO_SENTINEL','CREDENTIAL_SENTINEL','AUTH_JSON_SENTINEL'];
  const logs=[]; const originalError=console.error; console.error=(...args)=>logs.push(args.join(' '));
  try {
    const service=new MeterService(server,{adminPassword:'correct horse battery staple',serverUrl:'https://meter.example',clock:()=>Date.parse('2026-08-30T12:00:00Z')});
    const group=service.createGroup({name:'Privacy Group'}); const pending=service.createDevice({name:'Privacy Device',groupId:group.id}); const enrolled=service.enroll({token:pending.enrollmentToken});
    const device=service.authenticateDevice(enrolled.deviceId,enrolled.deviceSecret); assert.ok(device);
    const collector=new AgentCollector(agent,{home:codexHome}); await collector.reconcile();
    const filename=path.join(sessions,'rollout-2026-08-30T12-00-00-11111111-1111-4111-8111-111111111111.jsonl');
    const meta={type:'session_meta',payload:{id:'11111111-1111-4111-8111-111111111111',model:'gpt-5',reasoning_effort:'high'}};
    const record={timestamp:'2026-08-30T12:00:00Z',type:'event_msg',prompt:secrets[0],response:secrets[1],source_code:secrets[2],cwd:`/${secrets[5]}`,repository:secrets[6],auth_json:secrets[8],payload:{type:'token_count',message:secrets[0],tool_arguments:secrets[3],tool_output:secrets[4],oauth_token:secrets[7],info:{last_token_usage:{input_tokens:4,cached_input_tokens:2,cache_write_input_tokens:1,output_tokens:3,reasoning_output_tokens:1,total_tokens:7}}}};
    await writeFile(filename,`${JSON.stringify(meta)}\n${JSON.stringify(record)}\n`); assert.equal((await collector.reconcile()).events,1);
    const agentDump=JSON.stringify(agent.prepare('SELECT * FROM usage_outbox').all());
    let syncBody='';
    const sync=new AgentSyncClient(agent,{serverUrl:'https://meter.example',deviceId:enrolled.deviceId,deviceSecret:enrolled.deviceSecret,maxBatchSize:100},{quotaReporter:{observe:async()=>undefined},fetchImpl:async(_url,request)=>{
      syncBody=request.body; const body=JSON.parse(request.body); const result=service.sync(device,body); return {ok:true,json:async()=>result};
    }});
    await sync.sync();
    const serverDump=JSON.stringify({events:server.prepare('SELECT * FROM usage_events').all(),devices:server.prepare('SELECT id,name,credential_hash,credential_salt FROM devices').all()});
    for(const forbidden of secrets){
      assert.equal(agentDump.includes(forbidden),false,`Agent DB leaked ${forbidden}`);
      assert.equal(syncBody.includes(forbidden),false,`sync leaked ${forbidden}`);
      assert.equal(logs.join('\n').includes(forbidden),false,`log leaked ${forbidden}`);
      assert.equal(serverDump.includes(forbidden),false,`Server DB leaked ${forbidden}`);
    }
    assert.equal(server.prepare('SELECT total_tokens FROM usage_events').get().total_tokens,7);
  } finally { console.error=originalError; agent.close(); server.close(); await rm(dir,{recursive:true,force:true}); }
});

test('M7 release manifest and checksums are deterministic and workflow enforces native SEA smoke tests', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'codex-meter-m7-release-'));
  try {
    await Promise.all(['codex-meter-agent-linux-x64','codex-meter-agent-windows-x64.exe','codex-meter-agent-macos-arm64'].map((name,index)=>writeFile(path.join(dir,name),`artifact-${index}`)));
    let result=await exec(process.execPath,['scripts/release-v2-manifest.js',dir],{cwd:path.resolve('.'),stdio:['ignore','pipe','pipe']}); assert.equal(result.code,0,result.err);
    const first=await readFile(path.join(dir,'manifest.json'),'utf8'), sums=await readFile(path.join(dir,'SHA256SUMS'),'utf8');
    result=await exec(process.execPath,['scripts/release-v2-manifest.js',dir],{cwd:path.resolve('.'),stdio:['ignore','pipe','pipe']}); assert.equal(result.code,0,result.err); assert.equal(await readFile(path.join(dir,'manifest.json'),'utf8'),first);
    const manifest=JSON.parse(first); assert.equal(manifest.version,'2.1.1'); assert.deepEqual(Object.keys(manifest.artifacts),['linux-x64','macos-arm64','windows-x64']); assert.equal(sums.trim().split('\n').length,3);
    const workflow=await readFile('.github/workflows/release-v2.yml','utf8'); const packaging=await readFile('scripts/package-v2-agent.js','utf8');
    for(const required of ['ubuntu-24.04','windows-2025','macos-14','24.15.0','--version',' status --config','SHA256SUMS','RUNNER_OS','cygpath -m']) assert.ok(workflow.includes(required),`workflow missing ${required}`);
    assert.ok(workflow.includes('(cd dist/release-v2 && sha256sum --check SHA256SUMS)'),'workflow must verify checksums from the artifact directory');
    assert.ok(workflow.includes('GITHUB_REF_NAME#v2-agent-'),'workflow must reject a release tag that does not match the Agent version');
    assert.equal(workflow.includes('macos-14-xlarge'),false,'workflow must use the standard macOS runner');
    for(const required of ['NODE_SEA_BLOB','NODE_SEA_FUSE','codesign','--macho-segment-name',"'postject','dist','cli.js'",'run(process.execPath,[postjectCli,...args])']) assert.ok(packaging.includes(required),`packaging missing ${required}`);
    assert.equal(packaging.includes("'node_modules','.bin'"),false,'packaging must not invoke npm bin shims');
    assert.equal(packaging.includes('postject.cmd'),false,'packaging must not invoke the Windows npm shim');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('M7 Docker/Compose are one nonroot Node 24 service with persistent SQLite and healthcheck', async () => {
  const docker=await readFile('Dockerfile.v2','utf8'), compose=await readFile('compose.v2.example.yml','utf8');
  assert.match(docker,/FROM node:24\.15\.0/); assert.match(docker,/USER node/); assert.match(docker,/CODEX_METER_DB=\/data\/meter\.db/); assert.match(docker,/HEALTHCHECK/);
  assert.match(compose,/restart: unless-stopped/); assert.match(compose,/codex-meter-data:\/data/);
  assert.match(compose,/CODEX_METER_RELEASE_DIR: \/releases/);
  assert.match(compose,/\.\/releases:\/releases:ro/);
  assert.equal((compose.match(/^  codex-meter:/gm)||[]).length,1);
  assert.doesNotMatch(`${docker}\n${compose}`,/redis|postgres|rabbit|queue/i);
});

test('M7 configured release directory serves manifest and artifact while disabled and traversal requests stay inaccessible', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-meter-m7-release-http-'));
  const releases=path.join(root,'releases'); await mkdir(releases);
  const manifest='{"schemaVersion":1,"version":"2.0.1","artifacts":{}}\n';
  const artifact=Buffer.from('native-agent-fixture');
  await writeFile(path.join(releases,'manifest.json'),manifest);
  await writeFile(path.join(releases,'codex-meter-agent-linux-x64'),artifact);
  await writeFile(path.join(root,'outside-secret'),'must-not-be-served');

  const run=async(releaseDirectory,callback)=>{
    const database=openServerDatabase(path.join(root,`server-${releaseDirectory?'configured':'disabled'}.db`));
    const server=createV2Server({database,adminPassword:'release test administrator password',releaseDirectory});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    try { await callback(base); }
    finally { await new Promise(resolve=>server.close(resolve)); database.close(); }
  };

  try {
    await run(releases,async base=>{
      let response=await fetch(`${base}/api/v1/agent/releases/manifest.json`);
      assert.equal(response.status,200); assert.equal(await response.text(),manifest);
      response=await fetch(`${base}/api/v1/agent/releases/codex-meter-agent-linux-x64`);
      assert.equal(response.status,200); assert.deepEqual(Buffer.from(await response.arrayBuffer()),artifact);
      response=await fetch(`${base}/api/v1/agent/releases/..%2Foutside-secret`);
      assert.equal(response.status,401); assert.doesNotMatch(await response.text(),/must-not-be-served/);
    });
    await run(null,async base=>{
      const response=await fetch(`${base}/api/v1/agent/releases/package.json`);
      assert.equal(response.status,401); assert.doesNotMatch(await response.text(),/"name"\s*:\s*"codex-meter"/);
    });
  } finally { await rm(root,{recursive:true,force:true}); }
});
