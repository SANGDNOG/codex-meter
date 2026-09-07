import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HUB_RANGES, HUB_TOKENS, HUB_COUNTS, validateHubUsage, validateHubQuota, exactHub } from '../shared/hub-snapshot.js';

const LABEL=/^(main|p[a-f0-9]{6})$/;
const safeText=value=>String(value??'').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,'?').slice(0,200);
const connectionPath=config=>path.join(path.dirname(config.databasePath),'hub-connection.json');
const failure=(range,status,clock)=>({range,observedAt:new Date(clock()).toISOString(),since:null,status,tokens:null,counts:null,coverage:null});
function problem(code){throw new Error(code);}
function safeURL(input){
  let url;try{url=new URL(input);}catch{problem('invalid_hub_url');}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol))problem('invalid_hub_url');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))problem('hub_https_required');
  return url.origin;
}
async function privateRead(filename,{platform=process.platform}={}){
  const handle=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>16384||(platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid())))problem('private_file_required');return await handle.readFile('utf8');}
  finally{await handle.close();}
}
async function privateWrite(filename,contents){
  const temp=`${filename}.${randomUUID()}`;
  const handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(contents);await handle.close();await rename(temp,filename);}
  catch(error){await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});throw error;}
}
function credentialText(raw){const token=raw.trim();if(!token||token.length>8192||/[\x00-\x20\x7f]/u.test(token))problem('invalid_hub_credential');return token;}
async function credential(ref){
  if(ref.type==='env')return credentialText(process.env[ref.name]??'');
  if(ref.type==='file'){
    // POSIX ownership/mode is enforceable; Windows uses an explicitly supplied environment reference.
    if(process.platform==='win32')problem('use_hub_secret_env_on_windows');
    return credentialText(await privateRead(ref.path));
  }
  problem('invalid_hub_credential_reference');
}
async function boundedJSON(response){
  const reader=response.body?.getReader();if(!reader)problem('malformed');
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024)problem('malformed');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{await reader.cancel().catch(()=>{});problem('malformed');}
}
export class OpenCodexClient {
  constructor({url,credential:ref},{fetchImpl=fetch,clock=Date.now}={}){this.url=safeURL(url);this.ref=ref;this.fetch=fetchImpl;this.clock=clock;}
  async get(route){
    let response;
    try{response=await this.fetch(`${this.url}${route}`,{headers:{authorization:`Bearer ${await credential(this.ref)}`},redirect:'error',signal:AbortSignal.timeout(15000)});}
    catch{problem('hub_unavailable');}
    if(response.status===401||response.status===403)problem('hub_unauthorized');
    if(!response.ok)problem('hub_unavailable');
    const data=await boundedJSON(response);if(data?.error)problem(data.error==='read_failed'?'read_failed':'malformed');return data;
  }
  async accounts(){return parseHubAccounts(await this.get('/api/codex-auth/accounts'));}
  async usage(range,label){return parseHubUsage(await this.get(`/api/usage?range=${range}&surface=codex`),range,label,this.clock);}
}
export function parseHubAccounts(data){
  if(!data||!Array.isArray(data.accounts)||data.accounts.length>10000)problem('malformed');
  const labels=new Set();
  return data.accounts.map(row=>{
    if(!row||typeof row.logLabel!=='string'||!LABEL.test(row.logLabel))problem('identity_conflict');
    if(labels.has(row.logLabel)||((row.logLabel==='main')!==row.isMain))problem('identity_conflict');labels.add(row.logLabel);
    // Display-only fields never leave this process. No raw id/email/auth is projected.
    return{logLabel:row.logLabel,alias:safeText(row.alias??(row.isMain?'Main account':'Pool account')),plan:safeText(row.plan),isMain:row.isMain,quota:row.quota,needsReauth:row.needsReauth===true,quotaRefresh:row.quotaRefresh};
  });
}
export function parseHubUsage(data,range,label,clock=Date.now){
  if(data?.error)problem(data.error==='read_failed'?'read_failed':'malformed');
  if(!data||data.range!==range||data.surface!=='codex'||!Array.isArray(data.accounts)||!Number.isSafeInteger(data.generatedAt)||data.generatedAt<0||data.generatedAt>clock()+300000)problem('malformed');
  if(data.historyTruncated===true||data.entriesTruncated===true)problem('malformed');
  const seen=new Set();for(const row of data.accounts){if(!row||typeof row.accountLogLabel!=='string'||seen.has(row.accountLogLabel))problem('identity_conflict');seen.add(row.accountLogLabel);}
  const row=data.accounts.find(row=>row.accountLogLabel===label);
  if(row&&row.ambiguous!==false)problem(row.ambiguous===true?'ambiguous':'malformed');
  if(data.since!==null&&(!Number.isSafeInteger(data.since)||data.since<0||data.since>data.generatedAt))problem('malformed');
  const tokens={},counts={};
  for(const key of HUB_TOKENS){const value=row?row[key]:0;if(!Number.isSafeInteger(value)||value<0)problem('malformed');tokens[key]=String(value);}
  for(const key of HUB_COUNTS)counts[key]=row?row[key]:0;
  // No row means no explicitly labelled ledger attempts, NOT proof of complete coverage.
  return validateHubUsage({range,observedAt:new Date(data.generatedAt).toISOString(),since:data.since===null?null:new Date(data.since).toISOString(),status:'available',tokens,counts,coverage:row?row.usageCoverageRatio:0});
}
export function parseHubQuota(account,clock=Date.now){
  const unavailable=()=>({observedAt:new Date(clock()).toISOString(),status:'unavailable',windows:[]});
  const quota=account.quota;if(!quota||account.needsReauth)return unavailable();
  if(account.quotaRefresh&&account.quotaRefresh.status!=='ok')return unavailable();
  if(!Number.isSafeInteger(quota.updatedAt)||quota.updatedAt<0||quota.updatedAt>clock()+300000)problem('malformed');
  const windows=[];
  const append=(limitId,percent,reset,duration)=>{if(percent==null)return;windows.push({limitId,usedPercent:percent,durationMinutes:duration,resetsAt:reset==null?null:Number.isSafeInteger(reset)&&reset>=0?new Date(reset).toISOString():problem('malformed')});};
  append('weekly',quota.weeklyPercent,quota.weeklyResetAt,10080);
  append('monthly',quota.monthlyPercent,quota.monthlyResetAt,43200);
  const short=quota.shortWindowSeconds;
  append('short',quota.shortPercent,quota.shortResetAt,Number.isSafeInteger(short)&&short>0&&short%60===0?short/60:null);
  if(quota.customWindows!=null){if(!Array.isArray(quota.customWindows))problem('malformed');quota.customWindows.forEach((w,i)=>append(`custom-${i+1}`,w.percent,w.resetAt,null));}
  // Unknown custom durations remain unknown; never invent a 5H/Weekly duration.
  const observedAt=quota.shortPercent!=null&&Number.isSafeInteger(quota.shortObservedAt)?Math.min(quota.updatedAt,quota.shortObservedAt):quota.updatedAt;
  return validateHubQuota({observedAt:new Date(observedAt).toISOString(),status:windows.length?'available':'unavailable',windows});
}
export async function connectHub(database,config,{url,secretFile,secretEnv,secretStdin=false,input=process.stdin,fetchImpl=fetch}={}){
  if([Boolean(secretFile),Boolean(secretEnv),secretStdin].filter(Boolean).length!==1)problem('choose_one_hub_secret_input');
  if(database.prepare('SELECT 1 FROM hub_selections LIMIT 1').get())problem('stop_and_detach_hub_profiles_before_reconnect');
  const filename=connectionPath(config);let ref;
  if(secretFile)ref={type:'file',path:path.resolve(secretFile)};
  else if(secretEnv){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv))problem('invalid_secret_env');ref={type:'env',name:secretEnv};}
  else{
    if(input.isTTY)problem('pipe_hub_secret_via_stdin_or_use_secret_file');
    if(process.platform==='win32')problem('use_hub_secret_env_on_windows');
    let raw='';for await(const chunk of input){raw+=chunk;if(raw.length>8192)problem('invalid_hub_credential');}
    await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
    const tokenFile=path.join(path.dirname(filename),`hub-secret-${randomUUID()}`);
    await privateWrite(tokenFile,credentialText(raw));ref={type:'file',path:tokenFile};
  }
  const connection={connectionId:randomUUID(),url:safeURL(url),credential:ref};
  try{await new OpenCodexClient(connection,{fetchImpl}).accounts();await privateWrite(filename,JSON.stringify(connection));}
  catch{if(secretStdin)await unlink(ref.path).catch(()=>{});problem('hub_connect_failed');}
  return{connected:true};
}
async function loadConnection(config){try{return JSON.parse(await privateRead(connectionPath(config)));}catch{problem('hub_connection_required');}}
export async function meterHubRequest(config,method='GET',body,fetchImpl=fetch){
  let response;try{response=await fetchImpl(`${config.serverUrl}/api/v1/agent/hub`,{method,headers:{authorization:`Bearer ${config.deviceId}.${config.deviceSecret}`,'content-type':'application/json','x-codex-meter-opencodex':'1'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{problem('meter_hub_unavailable');}
  if(!response.ok)problem(response.status===404?'unsupported_server':'meter_hub_rejected');
  const result=await boundedJSON(response);if(method==='GET')validateHubDesired(result);return result;
}
export function validateHubDesired(result){
  exactHub(result,['schemaVersion','profiles']);if(result.schemaVersion!==1||!Array.isArray(result.profiles)||result.profiles.length>64)problem('invalid_hub_configuration');
  const ids=new Set(),accounts=new Set();for(const p of result.profiles){exactHub(p,['bindingId','accountId','name']);if(typeof p.bindingId!=='string'||typeof p.accountId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.bindingId)||!/^[A-Za-z0-9_-]{1,128}$/.test(p.accountId)||typeof p.name!=='string'||p.name.length>200||ids.has(p.bindingId)||accounts.has(p.accountId))problem('invalid_hub_configuration');ids.add(p.bindingId);accounts.add(p.accountId);}
  return result;
}
function pruneSelections(database,profiles){const ids=new Set(profiles.map(p=>p.bindingId));for(const row of database.prepare('SELECT binding_id FROM hub_selections').all())if(!ids.has(row.binding_id))database.prepare('DELETE FROM hub_selections WHERE binding_id=?').run(row.binding_id);}
export async function attachOpenCodex(database,config,{input=process.stdin,output=process.stdout,question,command='codex-meter-agent profile attach-opencodex',fetchImpl=fetch}={}){
  const desired=await meterHubRequest(config,'GET',undefined,fetchImpl);pruneSelections(database,desired.profiles);
  const pending=desired.profiles.filter(p=>!database.prepare('SELECT 1 FROM hub_selections WHERE binding_id=? AND account_id=?').get(p.bindingId,p.accountId));
  if(!pending.length){output.write('No profiles are waiting for OpenCodex selection.\n');return;}
  if(!question&&!input.isTTY){output.write(`ACTION REQUIRED:\n${command}\n`);return;}
  const reader=question?null:createInterface({input,output});const ask=question??(prompt=>reader.question(prompt));
  const choose=async(items,prompt)=>{const raw=await ask(prompt);if(!/^[1-9][0-9]*$/.test(raw)||!items[Number(raw)-1])problem('choose_a_listed_number');return items[Number(raw)-1];};
  try{
    if(pending.length>1)pending.forEach((p,i)=>output.write(`${i+1}. ${safeText(p.name)}\n`));
    const profile=pending.length===1?pending[0]:await choose(pending,'Account Profile number: ');
    const connection=await loadConnection(config),client=new OpenCodexClient(connection,{fetchImpl}),accounts=await client.accounts();
    output.write(`Account Profile: ${safeText(profile.name)}\nOpenCodex accounts (local display only)\n`);
    accounts.forEach((a,i)=>output.write(`${i+1}. ${a.alias}  ${a.plan}  ${a.logLabel}\n`));
    const account=await choose(accounts,'Select account: ');
    if(account.isMain){output.write('Main OpenCodex slot — changing/re-logging the main account changes which underlying provider account this source represents.\n');if(await ask('Track this slot? Type yes: ')!=='yes')return;}
    const live=await client.accounts();if(!live.some(a=>a.logLabel===account.logLabel))problem('account_removed');
    const current=await meterHubRequest(config,'GET',undefined,fetchImpl);if(!current.profiles.some(p=>p.bindingId===profile.bindingId&&p.accountId===profile.accountId))problem('profile_changed');
    if(database.prepare('SELECT 1 FROM hub_selections WHERE connection_id=? AND log_label=?').get(connection.connectionId,account.logLabel))problem('account_already_selected');
    database.prepare('INSERT INTO hub_selections(binding_id,account_id,log_label,connection_id,selected_at) VALUES(?,?,?,?,?)').run(profile.bindingId,profile.accountId,account.logLabel,connection.connectionId,new Date().toISOString());
    output.write('OpenCodex account selected. The Agent applies measurement automatically.\n');
  }finally{reader?.close();}
}
export class HubAdapter {
  constructor(database,config,{fetchImpl=fetch,clock=Date.now}={}){this.database=database;this.config=config;this.fetch=fetchImpl;this.clock=clock;this.next=0;}
  async sync(){
    // Refresh intent on every heartbeat: stopping is not delayed by quota cadence.
    const desired=await meterHubRequest(this.config,'GET',undefined,this.fetch);pruneSelections(this.database,desired.profiles);
    if(this.clock()<this.next)return;this.next=this.clock()+60000;
    if(!desired.profiles.length)return;
    let connection,client,accounts,accountError;
    const selected=desired.profiles.filter(p=>this.database.prepare('SELECT 1 FROM hub_selections WHERE binding_id=? AND account_id=?').get(p.bindingId,p.accountId));
    if(!selected.length)return;
    try{connection=await loadConnection(this.config);client=new OpenCodexClient(connection,{fetchImpl:this.fetch,clock:this.clock});accounts=await client.accounts();}catch(error){accountError=error.message==='identity_conflict'?'identity_conflict':'unavailable';}
    for(const profile of selected){
      const selection=this.database.prepare('SELECT * FROM hub_selections WHERE binding_id=? AND account_id=?').get(profile.bindingId,profile.accountId);if(!selection)continue;
      const account=accounts?.find(a=>a.logLabel===selection.log_label);
      const error=accountError??(selection.connection_id!==connection?.connectionId?'identity_conflict':!account?'account_removed':null);
      const usage=[];
      for(const range of HUB_RANGES){try{if(error)problem(error);usage.push(await client.usage(range,selection.log_label));}catch(e){usage.push(failure(range,['identity_conflict','account_removed','ambiguous','malformed','read_failed'].includes(e.message)?e.message:error??'unavailable',this.clock));}}
      let quota;try{quota=error?{observedAt:new Date(this.clock()).toISOString(),status:error,windows:[]}:parseHubQuota(account,this.clock);}catch{quota={observedAt:new Date(this.clock()).toISOString(),status:'malformed',windows:[]};}
      await meterHubRequest(this.config,'POST',{bindingId:profile.bindingId,state:usage.every(u=>u.status==='available')?'tracking':'unavailable',usage,quota},this.fetch);
    }
  }
}
