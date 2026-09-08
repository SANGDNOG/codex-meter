import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { openAgentDatabase } from '../v2/agent/database.js';
import { setupOpenCodex, connectHub, attachOpenCodex, HubAdapter } from '../v2/agent/opencodex.js';
import { setupQuestion } from '../v2/agent/setup-terminal.js';
import { runAgentCli } from '../v2/agent/cli.js';
import { saveConfig } from '../v2/agent/config.js';
import { HUB_TOKENS, HUB_COUNTS } from '../v2/shared/hub-snapshot.js';

const SECRET='synthetic-wizard-credential-only', NOW=Date.now();
const output=()=>({isTTY:true,text:'',write(value){this.text+=value;}});
const account=label=>({id:`private-${label}`,email:`${label}@private.example`,logLabel:label,alias:`Alias ${label}`,isMain:label==='main',plan:'pro',quota:{updatedAt:NOW,weeklyPercent:24,shortPercent:12,shortWindowSeconds:18000}});
const profile=(id='research',name='Research')=>({bindingId:`binding-${id}`,accountId:id,name});
async function fixture(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'meter-setup-test-')),database=openAgentDatabase(path.join(root,'agent.db'));
  const config={databasePath:path.join(root,'agent.db'),serverUrl:'https://meter.example',deviceId:'device',deviceSecret:'d'.repeat(32),codexHome:path.join(root,'unread-native'),profiles:[]};
  let profiles=[profile()],accounts=[account('p111aaa'),account('p222bbb')],hubStatus=200;
  const calls=[],reports=[],out=output();
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url);calls.push({origin:u.origin,path:u.pathname});
    if(u.origin==='https://meter.example'){
      assert.equal(init.headers.authorization,`Bearer device.${config.deviceSecret}`);
      if(init.method==='POST'){reports.push(JSON.parse(init.body));return Response.json({ok:true});}
      return Response.json({schemaVersion:1,profiles});
    }
    assert.equal(init.headers.authorization,`Bearer ${SECRET}`);assert.equal(init.redirect,'error');
    if(u.pathname==='/api/codex-auth/accounts')return Response.json({accounts},{status:hubStatus});
    return Response.json({range:u.searchParams.get('range'),surface:'codex',since:null,generatedAt:NOW,accounts:accounts.map((a,i)=>({accountLogLabel:a.logLabel,ambiguous:false,...Object.fromEntries(HUB_TOKENS.map(k=>[k,k==='totalTokens'?25+i:0])),...Object.fromEntries(HUB_COUNTS.map(k=>[k,1])),usageCoverageRatio:0.98}))});
  };
  const prompts=[];
  const wizard=(answers=['https://hub.example','2'],extra={})=>setupOpenCodex(database,config,{input:{isTTY:true},output:out,fetchImpl,
    question:async prompt=>{prompts.push(prompt);assert.ok(answers.length,`unexpected prompt: ${prompt}`);return answers.shift();},
    secretQuestion:async prompt=>{prompts.push(prompt);return SECRET;},...extra});
  const connect=()=>connectHub(database,config,{url:'https://hub.example',secretStdin:true,input:Readable.from([SECRET]),fetchImpl});
  try{await run({root,database,config,out,fetchImpl,calls,reports,prompts,wizard,connect,setProfiles:x=>profiles=x,setAccounts:x=>accounts=x,setStatus:x=>hubStatus=x});}
  finally{database.close();await rm(root,{recursive:true,force:true});}
}
const selected=c=>c.database.prepare('SELECT * FROM hub_selections').all();
const privateFiles=async c=>(await readdir(c.root)).filter(name=>name.startsWith('hub-'));

test('setup: enrollment is required before any prompt or Hub access',()=>fixture(async c=>{
  await assert.rejects(setupOpenCodex(c.database,{},{}),/agent_enrollment_required/);
  const stdout=output(),stderr=output();
  assert.equal(await runAgentCli(['opencodex','setup','--config',path.join(c.root,'missing.json')],{stdout,stderr}),1);
  assert.match(stderr.text,/Install\/enroll/);assert.doesNotMatch(stderr.text,/missing.json/);assert.equal(c.calls.length,0);
}));
test('setup help is available before enrollment',async()=>{
  const stdout=output();assert.equal(await runAgentCli(['opencodex','setup','--help'],{stdout}),0);assert.match(stdout.text,/opencodex setup/);
});
test('setup help does not intercept legacy connect or enrollment command routing',()=>fixture(async c=>{
  const file=path.join(c.root,'agent.json');await saveConfig(file,c.config);
  await assert.rejects(runAgentCli(['opencodex','connect','--help','--config',file],{stdout:c.out}),/choose_one_hub_secret_input/);
  await assert.rejects(runAgentCli(['enroll','--help'],{stdout:c.out}),/enroll requires/);
}));
test('setup: no pending Hub Profile never asks for a URL or credential',()=>fixture(async c=>{
  c.setProfiles([]);assert.equal((await c.wizard([])).status,'no_pending');assert.deepEqual(c.prompts,[]);
  assert.match(c.out.text,/No OpenCodex Hub profile is waiting for setup/);assert.match(c.out.text,/dashboard first/);
  assert.deepEqual(await privateFiles(c),[]);assert.ok(c.calls.every(x=>x.origin==='https://meter.example'));
}));
test('setup: first-time interactive flow selects exactly one account and uses private stdin storage',()=>fixture(async c=>{
  const argv=process.argv.slice();assert.equal((await c.wizard()).status,'complete');assert.deepEqual(process.argv,argv);
  assert.deepEqual(c.prompts,['Hub URL: ','Hub credential: ','Select account: ']);assert.equal(selected(c).length,1);assert.equal(selected(c)[0].log_label,'p222bbb');assert.equal(selected(c)[0].account_id,'research');
  const connection=JSON.parse(await readFile(path.join(c.root,'hub-connection.json'),'utf8'));
  assert.equal(path.dirname(connection.credential.path),c.root);assert.notEqual(connection.credential.path,c.config.databasePath);
  assert.equal(await readFile(connection.credential.path,'utf8'),SECRET);
  for(const file of [connection.credential.path,path.join(c.root,'hub-connection.json')]){const s=await stat(file);assert.equal(s.mode&0o777,0o600);assert.equal(s.uid,process.getuid());}
  assert.doesNotMatch(JSON.stringify(connection),new RegExp(SECRET));assert.doesNotMatch(c.out.text,/synthetic-wizard|@private|private-p/);
  assert.match(c.out.text,/Connected to OpenCodex Hub ✓/);assert.match(c.out.text,/OpenCodex setup complete ✓\nProfile: Research\nMeasurement will sync automatically/);
  assert.equal((await readFile(c.config.databasePath)).includes(Buffer.from(SECRET)),false);
}));
for(const url of ['http://remote.example','https://user:password@hub.example','https://hub.example/?token=x','https://hub.example/#x','https://hub.example/nested','file:///private']){
  test(`setup: unsafe ${url.split(':')[0]} URL rejected before secret prompt`,()=>fixture(async c=>{
    await assert.rejects(c.wizard([url]),/invalid_hub_url|hub_https_required/);assert.deepEqual(c.prompts,['Hub URL: ']);assert.deepEqual(await privateFiles(c),[]);
    assert.ok(c.calls.every(x=>x.origin==='https://meter.example'));
  }));
}
for(const url of ['https://hub.example','http://localhost:10100','http://127.0.0.1:10100','http://[::1]:10100']){
  test(`setup: supported origin ${new URL(url).hostname}`,()=>fixture(async c=>{assert.equal((await c.wizard([url,'1'])).status,'complete');}));
}
test('setup: credential-input cancellation leaves no secret or connection',()=>fixture(async c=>{
  await assert.rejects(c.wizard(['https://hub.example'],{secretQuestion:async()=>{throw new Error('setup_cancelled');}}),/setup_cancelled/);
  assert.deepEqual(await privateFiles(c),[]);assert.equal(selected(c).length,0);
}));
for(const secret of ['', 'bad token', 'x'.repeat(8193)])test('setup: invalid credential leaves no persisted secret',()=>fixture(async c=>{
  await assert.rejects(c.wizard(['https://hub.example'],{secretQuestion:async()=>secret}),/invalid_hub_credential/);assert.deepEqual(await privateFiles(c),[]);
}));
for(const status of [401,403,503])test(`setup: Hub failure ${status} cleans generated secret and sanitizes diagnostics`,()=>fixture(async c=>{
  c.setStatus(status);await assert.rejects(c.wizard(),{message:'hub_connect_failed'});assert.deepEqual(await privateFiles(c),[]);assert.equal(selected(c).length,0);assert.ok(!c.out.text.includes(SECRET));
}));
test('setup: existing valid connection reused without asking URL/credential or modifying files',()=>fixture(async c=>{
  await c.connect();const before=await readFile(path.join(c.root,'hub-connection.json'),'utf8'),files=await privateFiles(c);
  await c.wizard(['1']);assert.deepEqual(c.prompts,['Select account: ']);assert.equal(await readFile(path.join(c.root,'hub-connection.json'),'utf8'),before);assert.deepEqual(await privateFiles(c),files);
  const prompts=c.prompts.length,calls=c.calls.length;assert.equal((await c.wizard([])).status,'configured');assert.equal(c.prompts.length,prompts);assert.equal(c.calls.length,calls+1);
}));
test('setup: failed existing connection is not silently reconnected or overwritten',()=>fixture(async c=>{
  await c.connect();const before=await readFile(path.join(c.root,'hub-connection.json'),'utf8');c.setStatus(401);
  await assert.rejects(c.wizard([]),/hub_unauthorized/);assert.deepEqual(c.prompts,[]);assert.equal(await readFile(path.join(c.root,'hub-connection.json'),'utf8'),before);
}));
for(const state of ['missing','corrupt','invalid-reference','missing-secret'])test(`setup: selected profiles with ${state} connection require recovery, no prompts/reconnect`,()=>fixture(async c=>{
  await c.wizard();const file=path.join(c.root,'hub-connection.json'),connection=JSON.parse(await readFile(file,'utf8'));
  if(state==='missing')await rm(file);
  else if(state==='corrupt')await writeFile(file,'{');
  else if(state==='invalid-reference')await writeFile(file,JSON.stringify({...connection,credential:{type:'unexpected'}}));
  else await rm(connection.credential.path);
  const before=JSON.stringify(selected(c)),prompts=c.prompts.length,calls=c.calls.length;c.out.text='';
  assert.equal((await c.wizard([])).status,'action_required');assert.equal(c.prompts.length,prompts);assert.equal(JSON.stringify(selected(c)),before);assert.equal(c.calls.length,calls+1);
  assert.match(c.out.text,/Existing OpenCodex setup needs attention/);assert.doesNotMatch(c.out.text,/already configured|synthetic-wizard/);
}));
test('setup: missing connection with an existing selection does not request new credentials',()=>fixture(async c=>{
  await c.wizard();c.setProfiles([profile(),profile('second')]);await rm(path.join(c.root,'hub-connection.json'));
  const prompts=c.prompts.length;await assert.rejects(c.wizard([]),/hub_connection_required/);assert.equal(c.prompts.length,prompts);assert.equal(selected(c).length,1);
}));
test('setup: even a single Hub account requires explicit selection',()=>fixture(async c=>{
  c.setAccounts([account('p111aaa')]);await assert.rejects(c.wizard(['https://hub.example','']),/choose_a_listed_number/);assert.equal(selected(c).length,0);assert.match(c.prompts.at(-1),/Select account/);assert.doesNotMatch(c.out.text,/setup complete/);
}));
test('setup: multiple pending profiles are chosen before the account, not by UUID',()=>fixture(async c=>{
  c.setProfiles([profile(),profile('personal','Personal')]);await c.wizard(['https://hub.example','2','1']);
  assert.deepEqual(c.prompts.slice(-2),['Account Profile number: ','Select account: ']);assert.equal(selected(c)[0].account_id,'personal');assert.doesNotMatch(c.out.text,/binding-personal/);assert.match(c.out.text,/Profile: Personal/);
}));
for(const confirmation of ['no','yes'])test(`setup: main slot needs explicit confirmation (${confirmation})`,()=>fixture(async c=>{
  c.setAccounts([account('main')]);const result=await c.wizard(['https://hub.example','1',confirmation]);assert.match(c.out.text,/changing\/re-logging/);
  assert.equal(selected(c).length,confirmation==='yes'?1:0);assert.equal(result.status,confirmation==='yes'?'complete':'not_selected');
}));
test('setup: conflicting identity fails closed and cleans first-time credential',()=>fixture(async c=>{
  c.setAccounts([account('p111aaa'),account('p111aaa')]);await assert.rejects(c.wizard(),/hub_connect_failed/);assert.equal(selected(c).length,0);assert.deepEqual(await privateFiles(c),[]);
}));
test('setup: non-TTY never prompts or contacts Hub and prints existing manual commands',()=>fixture(async c=>{
  const result=await c.wizard([],{input:{isTTY:false},connectCommand:"'/agent with spaces' opencodex connect --config '/local config'",attachCommand:"'/agent with spaces' profile attach-opencodex --config '/local config'"});
  assert.equal(result.status,'action_required');assert.deepEqual(c.prompts,[]);assert.deepEqual(await privateFiles(c),[]);
  assert.match(c.out.text,/ACTION REQUIRED/);assert.match(c.out.text,/opencodex connect --config '\/local config'/);assert.match(c.out.text,/profile attach-opencodex/);assert.ok(c.calls.every(x=>x.origin==='https://meter.example'));
}));
test('setup: Windows uses an explicit environment reference, not a new credential file',()=>fixture(async c=>{
  process.env.METER_SETUP_TEST_CREDENTIAL=SECRET;
  try{await c.wizard(['https://hub.example','METER_SETUP_TEST_CREDENTIAL','2'],{platform:'win32',secretQuestion:async()=>assert.fail('no Windows secret prompt')});
    const connection=JSON.parse(await readFile(path.join(c.root,'hub-connection.json'),'utf8'));assert.deepEqual(connection.credential,{type:'env',name:'METER_SETUP_TEST_CREDENTIAL'});assert.deepEqual(await privateFiles(c),['hub-connection.json']);assert.ok(!c.out.text.includes(SECRET));
  }finally{delete process.env.METER_SETUP_TEST_CREDENTIAL;}
}));
test('setup: advanced connect and attach retain their original behavior and completion message',()=>fixture(async c=>{
  await c.connect();await attachOpenCodex(c.database,c.config,{fetchImpl:c.fetchImpl,output:c.out,question:async()=>'1'});
  assert.equal(selected(c)[0].log_label,'p111aaa');assert.match(c.out.text,/OpenCodex account selected\. The Agent applies measurement automatically/);
}));
test('setup: existing adapter sees selection without restart and sends only existing allowlisted snapshots',()=>fixture(async c=>{
  let now=NOW;const adapter=new HubAdapter(c.database,c.config,{fetchImpl:c.fetchImpl,clock:()=>now});await adapter.sync();assert.equal(c.reports.length,0);
  await c.wizard();now+=60000;await adapter.sync();assert.equal(c.reports.length,1);
  const wire=JSON.stringify(c.reports);assert.doesNotMatch(wire,/synthetic-wizard|hub.example|logLabel|p111aaa|p222bbb|private-|email|credential|unread-native/);
  assert.equal(c.reports[0].bindingId,'binding-research');assert.equal(c.reports[0].usage.length,4);assert.ok(c.reports[0].usage.every(u=>u.tokens.totalTokens==='26'));
  assert.equal(c.database.prepare('SELECT COUNT(*) n FROM rollout_cursors').get().n,0);assert.equal(c.database.prepare('SELECT COUNT(*) n FROM usage_outbox').get().n,0);
}));
test('setup: CLI recognizes command and includes actual config in non-TTY guidance',()=>fixture(async c=>{
  const file=path.join(c.root,'agent.json');await saveConfig(file,c.config);const original=globalThis.fetch;globalThis.fetch=c.fetchImpl;
  try{assert.equal(await runAgentCli(['opencodex','setup','--config',file],{stdout:c.out}),1);assert.match(c.out.text,/opencodex connect/);assert.ok(c.out.text.includes(file));assert.ok(!c.out.text.includes(SECRET));}
  finally{globalThis.fetch=original;}
}));

function terminal(){
  const input=new PassThrough(),out=new PassThrough(),signals=new EventEmitter();let text='';
  input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};out.isTTY=true;out.columns=80;out.on('data',chunk=>text+=chunk);
  return{input,output:out,signals,text:()=>text};
}
test('setup: complete TTY flow uses production hidden-input reader, no injected questions',()=>fixture(async c=>{
  const tty=terminal(),steps=[['Hub URL: ','https://hub.example'],['Hub credential: ',SECRET],['Select account: ','2']];
  let next=0;tty.output.on('data',()=>{
    if(next<steps.length&&tty.text().includes(steps[next][0])){const answer=steps[next++][1];queueMicrotask(()=>tty.input.write(answer+'\r'));}
  });
  const result=await setupOpenCodex(c.database,c.config,{input:tty.input,output:tty.output,fetchImpl:c.fetchImpl});
  assert.equal(result.status,'complete');assert.equal(next,3);assert.equal(selected(c)[0].log_label,'p222bbb');
  assert.ok(!tty.text().includes(SECRET));assert.match(tty.text(),/setup complete/);assert.equal(tty.input.isRaw,false);
}));
test('hidden input: real readline mute path suppresses credential echo and restores raw mode',async()=>{
  const tty=terminal();const promise=setupQuestion('Hub credential: ',{...tty,secret:true});assert.equal(tty.input.isRaw,true);
  tty.input.write(SECRET+'\r');assert.equal(await promise,SECRET);assert.equal(tty.input.isRaw,false);assert.equal(tty.text(),'Hub credential: \n');assert.equal(tty.signals.listenerCount('SIGTERM'),0);
});
for(const kind of ['ctrl-c','eof','sigterm','error'])test(`hidden input: ${kind} cancels without echo and restores terminal`,async()=>{
  const tty=terminal(),promise=setupQuestion('Hub credential: ',{...tty,secret:true});tty.input.write(SECRET);
  const rejection=assert.rejects(promise,/setup_cancelled|terminal_input_failed/);
  if(kind==='ctrl-c')tty.input.write('\x03');else if(kind==='eof')tty.input.end();else if(kind==='sigterm')tty.signals.emit('SIGTERM');else tty.input.emit('error',new Error(SECRET));
  await rejection;assert.equal(tty.input.isRaw,false);assert.ok(!tty.text().includes(SECRET));assert.equal(tty.signals.listenerCount('SIGINT'),0);
});
test('hidden input: non-TTY fails before reading',async()=>{await assert.rejects(setupQuestion('secret',{input:{isTTY:false},output:{isTTY:false},secret:true}),/interactive_terminal_required/);});
for(const stream of ['input','output'])test(`hidden input: next-tick ${stream} error after answer is sanitized and contained`,async()=>{
  const tty=terminal(),promise=setupQuestion('Hub credential: ',{...tty,secret:true}),rejection=assert.rejects(promise,{message:'terminal_input_failed'});
  tty.input.write(SECRET+'\r');process.nextTick(()=>tty[stream].emit('error',new Error(SECRET)));await rejection;
  assert.equal(tty.input.isRaw,false);assert.ok(!tty.text().includes(SECRET));
});
test('hidden input: asynchronous Writable failure during final output cannot escape cleanup',async()=>{
  const tty=terminal(),out=new Writable({write(_chunk,_encoding,done){process.nextTick(()=>done(new Error(SECRET)));}});out.isTTY=true;
  const promise=setupQuestion('Hub credential: ',{...tty,output:out,secret:true}),rejection=assert.rejects(promise,{message:'terminal_input_failed'});
  tty.input.write(SECRET+'\r');await rejection;assert.equal(tty.input.isRaw,false);assert.equal(out.listenerCount('error'),0);
});
