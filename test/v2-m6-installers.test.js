import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  fetchVerifiedArtifact, launchAgentPlist, lifecyclePaths, releaseTarget, serviceStatus, systemdUnit,
  uninstallInstalledAgent, updateInstalledAgent, validateManifest, windowsTaskCommand
} from '../v2/agent/lifecycle.js';

const ROOT = path.resolve('v2/install');
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function temp(prefix = 'codex-meter-m6-') { return mkdtemp(path.join(os.tmpdir(), prefix)); }
function response(value, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value, arrayBuffer: async () => Buffer.from(value) }; }
function exec(command, args, options = {}) {
  return new Promise((resolve) => { const child=spawn(command,args,options); let out='',err=''; child.stdout?.on('data',c=>out+=c); child.stderr?.on('data',c=>err+=c); child.on('exit',code=>resolve({code,out,err})); });
}

test('M6 maps only the three supported platform/architecture targets and per-user locations', () => {
  assert.equal(releaseTarget('linux','x64'),'linux-x64'); assert.equal(releaseTarget('darwin','arm64'),'macos-arm64'); assert.equal(releaseTarget('win32','x64'),'windows-x64');
  assert.throws(()=>releaseTarget('linux','arm64'),/unsupported/); assert.throws(()=>releaseTarget('darwin','x64'),/unsupported/); assert.throws(()=>releaseTarget('freebsd','x64'),/unsupported/);
  assert.match(lifecyclePaths('linux',{},'/private/home').executable,/\.local[\\/]bin/);
  assert.match(lifecyclePaths('darwin',{},'/private/home').service,/LaunchAgents/);
  assert.match(lifecyclePaths('win32',{LOCALAPPDATA:'C:\\Users\\u\\AppData\\Local'},'C:\\Users\\u').executable,/CodexMeter[\\/]codex-meter-agent\.exe$/);
});

test('M6 manifest validation and verified fetch reject absent target and checksum mismatch before creating destination', async () => {
  const dir=await temp(); const destination=path.join(dir,'agent'); const bytes=Buffer.from('verified-agent');
  try {
    assert.throws(()=>validateManifest({version:'2',artifacts:{}},'linux-x64'),/no valid artifact/);
    const manifest={version:'2.1.0',artifacts:{'linux-x64':{url:'agent-linux',sha256:digest(bytes)}}};
    const calls=[]; const fetchImpl=async url=>{calls.push(String(url));return calls.length===1?response(manifest):response(bytes);};
    assert.equal((await fetchVerifiedArtifact({serverUrl:'https://meter.example',target:'linux-x64',fetchImpl,destination})).version,'2.1.0');
    assert.deepEqual(await readFile(destination),bytes); assert.match(calls[0],/manifest\.json$/); assert.match(calls[1],/agent-linux$/);
    const mismatch=path.join(dir,'mismatch'); let count=0;
    await assert.rejects(fetchVerifiedArtifact({serverUrl:'https://meter.example',target:'linux-x64',destination:mismatch,fetchImpl:async()=>++count===1?response(manifest):response('tampered')}),/checksum mismatch/);
    await assert.rejects(readFile(mismatch),{code:'ENOENT'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('M6 service templates construct quoted per-user run commands without privilege elevation', () => {
  const unit=systemdUnit('/home/u/.local/bin/codex-meter-agent','/home/u/state/agent.json');
  assert.match(unit,/ExecStart="\/home\/u\/\.local\/bin\/codex-meter-agent" run --config/); assert.doesNotMatch(unit,/sudo|User=root/);
  const plist=launchAgentPlist('/Users/u/Library/Application Support/Codex Meter/agent','/Users/u/config'); assert.match(plist,/RunAtLoad/); assert.match(plist,/KeepAlive/);
  assert.equal(windowsTaskCommand('C:\\Agent\\agent.exe','C:\\Agent\\agent.json'),'"C:\\Agent\\agent.exe" run --config "C:\\Agent\\agent.json"');
});

test('M6 Linux installer performs verified enrollment, protects files, registers and starts only mocked user service', async () => {
  const dir=await temp(); const home=path.join(dir,'home'), fixtures=path.join(dir,'fixtures'), mockbin=path.join(dir,'mockbin'); await mkdir(home,{recursive:true}); await mkdir(fixtures); await mkdir(mockbin);
  const artifact=path.join(fixtures,'agent'); const manifest=path.join(fixtures,'manifest.json'); const log=path.join(dir,'commands.log');
  const agent=`#!/bin/sh\nconfig=''\nwhile [ "$#" -gt 0 ]; do [ "$1" = --config ] && { config=$2; shift 2; continue; }; shift; done\n[ -n "$config" ] || exit 2\nprintf '{"enrolled":true}\\n' > "$config"\n`;
  await writeFile(artifact,agent,{mode:0o700}); await chmod(artifact,0o700);
  await writeFile(manifest,JSON.stringify({version:'2.0.0',artifacts:{'linux-x64':{url:'agent',sha256:digest(agent)}}}));
  await writeFile(path.join(mockbin,'curl'),`#!/bin/sh\ncase "$2" in *manifest.json) cp "$CM_MANIFEST" "$4";; *) cp "$CM_ARTIFACT" "$4";; esac\n`,{mode:0o700});
  await writeFile(path.join(mockbin,'systemctl'),`#!/bin/sh\nprintf '%s\\n' "$*" >> "$CM_LOG"\n`,{mode:0o700});
  try {
    const result=await exec('sh',[path.join(ROOT,'install.sh'),'--server','http://127.0.0.1:9','--token','one_time_token'],{env:{...process.env,PATH:`${mockbin}:${process.env.PATH}`,CODEX_METER_HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.local','state'),CODEX_METER_ALLOW_HTTP_TESTS:'1',CM_MANIFEST:manifest,CM_ARTIFACT:artifact,CM_LOG:log},stdio:['ignore','pipe','pipe']});
    assert.equal(result.code,0,result.err); const bin=path.join(home,'.local','bin','codex-meter-agent'), config=path.join(home,'.local','state','codex-meter','agent.json'), service=path.join(home,'.config','systemd','user','codex-meter-agent.service');
    assert.equal((await stat(config)).mode&0o777,0o600); assert.equal((await stat(service)).mode&0o777,0o600); assert.equal((await stat(bin)).mode&0o777,0o700);
    assert.match(await readFile(service,'utf8'),/ExecStart=.* run --config/); const commands=await readFile(log,'utf8'); assert.match(commands,/--user daemon-reload/); assert.match(commands,/--user enable --now/); assert.doesNotMatch(commands,/sudo/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('M6 installer checksum mismatch refuses replacement, enrollment, and service registration', async () => {
  const dir=await temp(); const home=path.join(dir,'home'), mockbin=path.join(dir,'mockbin'); await mkdir(path.join(home,'.local','bin'),{recursive:true}); await mkdir(mockbin);
  const existing=path.join(home,'.local','bin','codex-meter-agent'); await writeFile(existing,'known-good'); const artifact=path.join(dir,'bad'); await writeFile(artifact,'tampered');
  const manifest=path.join(dir,'manifest.json'); await writeFile(manifest,JSON.stringify({version:'2',artifacts:{'linux-x64':{url:'bad',sha256:'0'.repeat(64)}}}));
  const marker=path.join(dir,'service-called'); await writeFile(path.join(mockbin,'curl'),`#!/bin/sh\ncase "$2" in *manifest.json) cp "$CM_MANIFEST" "$4";; *) cp "$CM_ARTIFACT" "$4";; esac\n`,{mode:0o700}); await writeFile(path.join(mockbin,'systemctl'),`#!/bin/sh\ntouch "$CM_MARKER"\n`,{mode:0o700});
  try { const result=await exec('sh',[path.join(ROOT,'install.sh'),'--server','http://localhost:9','--token','token'],{env:{...process.env,PATH:`${mockbin}:${process.env.PATH}`,CODEX_METER_HOME:home,CODEX_METER_ALLOW_HTTP_TESTS:'1',CM_MANIFEST:manifest,CM_ARTIFACT:artifact,CM_MARKER:marker},stdio:['ignore','pipe','pipe']});
    assert.notEqual(result.code,0); assert.match(result.err,/checksum mismatch/); assert.equal(await readFile(existing,'utf8'),'known-good'); await assert.rejects(readFile(marker),{code:'ENOENT'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('M6 status, atomic update, Windows replacement helper, and uninstall use mocked lifecycle commands', async () => {
  const dir=await temp(); const state=path.join(dir,'state'); await mkdir(state); const executable=path.join(state,'agent'); const configPath=path.join(state,'agent.json'), db=path.join(state,'agent.db'); await writeFile(executable,'old'); await writeFile(configPath,'{}'); await writeFile(db,'db');
  const paths={platform:'linux',state,executable,config:configPath,service:path.join(dir,'agent.service')}; await writeFile(paths.service,'service');
  const bytes=Buffer.from('new-agent'), manifest={version:'2.2.0',artifacts:{'linux-x64':{url:'agent',sha256:digest(bytes)}}}; let fetchCount=0; const commands=[]; const run=async(c,a)=>{commands.push([c,...a]);return c==='systemctl'&&a.includes('is-active')?'active\n':'';};
  try {
    assert.deepEqual(await serviceStatus(paths,run),{service:'active'});
    const result=await updateInstalledAgent({serverUrl:'https://meter.example'},{paths,platform:'linux',run,fetchImpl:async()=>++fetchCount===1?response(manifest):response(bytes),pid:123});
    assert.deepEqual(result,{version:'2.2.0',update:'installed'}); assert.equal(await readFile(executable,'utf8'),'new-agent'); assert.ok(commands.some(c=>c.join(' ').includes('--user restart')));
    await uninstallInstalledAgent(configPath,{databasePath:db},{paths,run}); await assert.rejects(readFile(executable),{code:'ENOENT'}); assert.ok(commands.some(c=>c.join(' ').includes('disable --now')));

    const winState=path.join(dir,'win'); await mkdir(winState); const winExe=path.join(winState,'agent.exe'); await writeFile(winExe,'old'); const winPaths={platform:'win32',state:winState,executable:winExe,config:path.join(winState,'agent.json'),task:'Codex Meter Agent'}; let n=0; const winCommands=[];
    const winResult=await updateInstalledAgent({serverUrl:'https://meter.example'},{paths:winPaths,platform:'win32',pid:456,run:async(c,a)=>winCommands.push([c,...a]),fetchImpl:async()=>++n===1?response({version:'2.2.0',artifacts:{'windows-x64':{url:'agent.exe',sha256:digest(bytes)}}}):response(bytes)});
    assert.equal(winResult.update,'scheduled'); const helper=await readFile(`${winExe}.replace-456.cmd`,'utf8'); assert.match(helper,/tasklist/); assert.match(helper,/move \/Y/); assert.match(helper,/schtasks\.exe \/Run/); assert.equal(await readFile(winExe,'utf8'),'old'); assert.equal(winCommands[0][0],'cmd.exe');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('M6 PowerShell installer and all templates are present with checksum, least-privilege task, and replacement support', async () => {
  const ps=await readFile(path.join(ROOT,'install.ps1'),'utf8'); assert.match(ps,/Get-FileHash -Algorithm SHA256/); assert.match(ps,/schtasks\.exe \/Create/); assert.match(ps,/\/RL LIMITED/); assert.match(ps,/Move-Item -Force/); assert.match(ps,/icacls\.exe/);
  const task=await readFile(path.join(ROOT,'templates','codex-meter-agent-task.xml'),'utf8'); assert.match(task,/LeastPrivilege/); assert.match(task,/InteractiveToken/);
  const shell=await readFile(path.join(ROOT,'install.sh'),'utf8'); assert.match(shell,/systemctl/); assert.match(shell,/launchctl/); assert.doesNotMatch(shell,/sudo/);
});
