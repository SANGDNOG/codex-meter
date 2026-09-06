import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentCollector } from './collector.js';
import { initializeManagedHome, profileLauncher } from './config.js';
import { lifecyclePaths } from './lifecycle.js';
import { canonicalHome, homesOverlap } from './paths.js';
import { assertExistingLocation } from './existing-home.js';
import { profileRootKey, readExistingRoot } from './existing-root.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MODES = new Set(['default','isolated','preserve','existing']);
const CONFIG_STATUSES = new Set(['unknown','applying','healthy','apply_failed','migration_attention_required']);
const PROFILE_STATES = new Set(['tracking','login_required','quota_available','quota_unavailable','apply_failed','migration_attention_required','stopped','local_selection_required']);

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function safeId(value, label) { if(typeof value!=='string'||!ID.test(value))throw new Error(`invalid ${label}`);return value; }
function safeName(value) { if(typeof value!=='string'||!value.trim()||value.length>200||/[\0\r\n\u2028\u2029]/u.test(value))throw new Error('invalid profile name');return value.trim(); }
function state(database,key,value,clock=Date.now){const at=new Date(clock()).toISOString();database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(value),at);}
function stateValue(database,key,fallback=null){return database.prepare('SELECT value FROM agent_state WHERE key=?').get(key)?.value??fallback;}

export function validateDesiredConfiguration(value) {
  const required=['schemaVersion','revision','syncIntervalSeconds','heartbeatIntervalSeconds','maxBatchSize','profiles'];
  if(!exact(value,required)||value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<0)throw new Error('invalid desired configuration');
  if(!Number.isSafeInteger(value.syncIntervalSeconds)||value.syncIntervalSeconds<1||value.syncIntervalSeconds>86400)throw new Error('invalid desired configuration');
  if(!Number.isSafeInteger(value.heartbeatIntervalSeconds)||value.heartbeatIntervalSeconds<1||value.heartbeatIntervalSeconds>86400)throw new Error('invalid desired configuration');
  if(!Number.isSafeInteger(value.maxBatchSize)||value.maxBatchSize<1||value.maxBatchSize>100)throw new Error('invalid desired configuration');
  if(!Array.isArray(value.profiles)||value.profiles.length>64)throw new Error('invalid desired configuration');
  const profiles=value.profiles.map((profile)=>{
    if(!exact(profile,['bindingId','accountId','name','mode',...(profile?.mode==='existing'?['selectionKey']:[])]))throw new Error('invalid desired profile declaration');
    const mode=profile.mode;if(!MODES.has(mode))throw new Error('invalid desired profile mode');
    return Object.freeze({bindingId:safeId(profile.bindingId,'bindingId'),accountId:safeId(profile.accountId,'accountId'),name:safeName(profile.name),mode,...(mode==='existing'?{selectionKey:safeId(profile.selectionKey,'selectionKey')}:{})});
  });
  if(new Set(profiles.map((p)=>p.bindingId)).size!==profiles.length||new Set(profiles.map((p)=>p.accountId)).size!==profiles.length)throw new Error('duplicate desired profile');
  if(profiles.filter((p)=>p.mode==='default').length>1)throw new Error('multiple default profiles are not allowed');
  return Object.freeze({...value,profiles:Object.freeze(profiles)});
}

export function assignmentRows(database,{activeOnly=true}={}){
  return database.prepare(`SELECT * FROM profile_assignments ${activeOnly?'WHERE active=1':''} ORDER BY mode='default' DESC,created_at,binding_id`).all().map((row)=>({
    bindingId:row.binding_id,accountId:row.account_id,name:row.name,mode:row.mode,origin:row.origin,localHome:row.local_home,
    launcherName:row.launcher_name,active:Boolean(row.active),desiredRevision:row.desired_revision,appliedRevision:row.applied_revision,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at,selectionKey:row.selection_key
  })).map(profile=>{
    if(profile.mode!=='existing')return profile;
    const rootIdentity=readExistingRoot(database,profileRootKey(profile),profile.localHome);
    return {...profile,rootIdentity,...(profile.active&&profile.localHome&&!rootIdentity?{localHome:null,state:'local_selection_required'}:{})};
  });
}

export function configurationState(database){
  const desired=Number(stateValue(database,'desired_config_revision','0')),applied=Number(stateValue(database,'applied_config_revision','0'));
  const status=stateValue(database,'configuration_status','unknown');
  return {desiredRevision:Number.isSafeInteger(desired)&&desired>=0?desired:0,appliedRevision:Number.isSafeInteger(applied)&&applied>=0?applied:0,
    status:CONFIG_STATUSES.has(status)?status:'unknown',errorKind:stateValue(database,'configuration_error_kind','')||null,
    profiles:assignmentRows(database).map((row)=>({bindingId:row.bindingId,accountId:row.accountId,mode:row.mode,state:PROFILE_STATES.has(row.state)?row.state:'apply_failed',...(row.launcherName?{launcher:row.launcherName}:{})}))};
}

async function matchingLegacyLauncher(name,profile,{directory=defaultLauncherDirectory(),platform=process.platform}={}){
  try{return await readFile(launcherFilename(directory,name,platform),'utf8')===profileLauncher(profile,platform);}catch{return false;}
}

export async function importLegacyProfiles(database,config,{clock=Date.now,launcherExists=null,launcherDirectory,platform=process.platform}={}){
  // Only explicit local config entries are eligible. Re-running permits a later
  // user opt-in without discovering arbitrary launchers or CODEX_HOME trees.
  const now=new Date(clock()).toISOString(),profiles=config.profiles??[];
  database.exec('BEGIN IMMEDIATE');
  try{
    const insert=database.prepare(`INSERT OR IGNORE INTO profile_assignments(binding_id,account_id,name,mode,origin,local_home,launcher_name,active,desired_revision,applied_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(let index=0;index<profiles.length;index++){
      const profile=profiles[index],candidate=`cx${index+1}`,launcherName=await (launcherExists?launcherExists(candidate,profile):matchingLegacyLauncher(candidate,profile,{directory:launcherDirectory,platform}))?candidate:null;
      insert.run(`legacy-${profile.accountId}`,profile.accountId,profile.name,'preserve','imported',profile.codexHome,launcherName,1,0,0,'tracking',now,now);
    }
    state(database,'legacy_profiles_imported','true',clock);database.exec('COMMIT');
  }catch(error){database.exec('ROLLBACK');throw error;}
  return assignmentRows(database,{activeOnly:false});
}

function defaultIsolatedRoot(config,bindingId){return path.join(path.dirname(config.databasePath),'profiles',bindingId);}
function defaultLauncherDirectory(){return path.dirname(lifecyclePaths(process.platform,process.env,os.homedir()).executable);}
function launcherFilename(directory,name,platform=process.platform){return path.join(directory,platform==='win32'?`${name}.ps1`:name);}
async function createLauncher(profile,{directory=defaultLauncherDirectory(),platform=process.platform}={}){
  await mkdir(directory,{recursive:true,mode:0o700});if(platform!=='win32')await chmod(directory,0o700);
  const contents=profileLauncher(profile,platform);
  for(let index=1;index<=999;index++){
    const name=`cx${index}`,filename=launcherFilename(directory,name,platform);
    try{
      const info=await lstat(filename);
      if(!info.isSymbolicLink()&&info.isFile()&&await readFile(filename,'utf8')===contents)return{name,filename};
      continue;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const handle=await open(filename,'wx',0o700);
    try{await handle.write(contents);}finally{await handle.close();}
    if(platform!=='win32')await chmod(filename,0o700);return{name,filename};
  }
  throw new Error('no safe launcher name is available');
}

export async function applyDesiredConfiguration(database,config,raw,{clock=Date.now,isolatedRoot=defaultIsolatedRoot,launcherDirectory,platform=process.platform,baseline}={}){
  const currentDesired=Number(stateValue(database,'desired_config_revision','0')),currentApplied=Number(stateValue(database,'applied_config_revision','0'));
  let desired;
  try{desired=validateDesiredConfiguration(raw);}
  catch(error){
    const candidate=raw&&typeof raw==='object'&&Number.isSafeInteger(raw.revision)&&raw.revision>=0?raw.revision:null;
    if(candidate!==null&&candidate>=currentDesired){state(database,'desired_config_revision',candidate,clock);state(database,'configuration_status','apply_failed',clock);state(database,'configuration_error_kind','invalid_desired_configuration',clock);}
    return{applied:false,error,...configurationState(database)};
  }
  if(desired.revision<currentDesired)return{ignored:true,reason:'older_revision',...configurationState(database)};
  state(database,'desired_configuration',JSON.stringify(desired),clock);
  const localRevision=stateValue(database,'local_selection_revision','0');
  if(desired.revision===currentApplied&&desired.revision===currentDesired&&localRevision===stateValue(database,'applied_local_selection_revision','0'))return{idempotent:true,...configurationState(database)};
  state(database,'desired_config_revision',desired.revision,clock);state(database,'configuration_status','applying',clock);state(database,'configuration_error_kind','',clock);
  const existing=assignmentRows(database,{activeOnly:false}),byAccount=new Map(existing.map((row)=>[row.accountId,row])),planned=[];
  try{
    for(const declaration of desired.profiles){
      const previous=byAccount.get(declaration.accountId);
      let mode=declaration.mode,origin='server',localHome,launcherName=previous?.launcherName??null,initialize=false;
      if(declaration.mode==='existing'){
        origin='adopted';launcherName=null;
        const selection=database.prepare('SELECT canonical_home FROM existing_home_selections WHERE binding_id=? AND account_id=? AND selection_key=?').get(declaration.bindingId,declaration.accountId,declaration.selectionKey);
        const selected=selection&&readExistingRoot(database,profileRootKey(declaration),selection.canonical_home);
        if(selected)await assertExistingLocation(selection.canonical_home);
        localHome=selected?selection.canonical_home:null;
      }
      else if(previous?.origin==='imported'&&(declaration.mode==='preserve'||declaration.mode==='isolated')){mode='preserve';origin='imported';localHome=previous.localHome;}
      else if(declaration.mode==='default'){localHome=config.codexHome;launcherName=null;}
      else if(declaration.mode==='preserve'&&previous){mode=previous.mode;origin=previous.origin;localHome=previous.localHome;}
      else if(declaration.mode==='preserve'&&existing.length===0&&(config.profiles?.length??0)===0&&desired.profiles.length===1){mode='preserve';origin='imported';localHome=config.codexHome;launcherName=null;}
      else if(declaration.mode==='preserve')throw new Error('preserve profile has no local assignment');
      else{localHome=previous?.active&&previous.mode==='isolated'?previous.localHome:isolatedRoot(config,declaration.bindingId);initialize=true;}
      planned.push({...declaration,mode,origin,localHome,launcherName,initialize});
    }
    const canonicalHomes=[];
    for(const entry of planned)canonicalHomes.push(entry.localHome===null?null:await canonicalHome(entry.localHome,{platform}));
    if(new Set(canonicalHomes.filter(Boolean)).size!==canonicalHomes.filter(Boolean).length)throw new Error('profile homes overlap');
    for(let left=0;left<canonicalHomes.length;left++)for(let right=left+1;right<canonicalHomes.length;right++){
      if(canonicalHomes[left]&&canonicalHomes[right]&&homesOverlap(canonicalHomes[left],canonicalHomes[right]))throw new Error('profile homes overlap');
    }
    const protectedDefault=planned.some(entry=>entry.initialize)?await canonicalHome(config.codexHome,{platform}):null;
    for(let index=0;index<planned.length;index++)if(planned[index].initialize&&homesOverlap(canonicalHomes[index],protectedDefault))throw new Error('managed profile overlaps default home');
    for(const entry of planned)if(entry.initialize){await initializeManagedHome(entry.localHome,entry.accountId);if(!entry.launcherName){const created=await createLauncher({codexHome:entry.localHome,codexExecutable:config.codexExecutable},{directory:launcherDirectory,platform});entry.launcherName=created.name;}}
    for(const entry of planned){
      if(entry.mode==='existing')continue; // Only the explicit local attach establishes its EOF baseline.
      const prior=byAccount.get(entry.accountId),reactivated=prior&&!prior.active,homeChanged=prior&&prior.localHome!==entry.localHome;
      const changed=!prior||reactivated||prior.bindingId!==entry.bindingId||homeChanged;
      if(changed){const collector=new AgentCollector(database,{home:entry.localHome,accountId:entry.accountId,clock});await (baseline?baseline(collector,entry):reactivated||homeChanged?collector.baselineCurrent():collector.reconcile());}
    }
    const now=new Date(clock()).toISOString();database.exec('BEGIN IMMEDIATE');
    try{
      database.prepare('UPDATE profile_assignments SET active=0,state=\'stopped\',updated_at=? WHERE active=1').run(now);
      const insert=database.prepare(`INSERT INTO profile_assignments(binding_id,account_id,name,mode,origin,local_home,launcher_name,active,desired_revision,applied_revision,state,created_at,updated_at,selection_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for(const entry of planned){const prior=byAccount.get(entry.accountId),runtimeState=entry.localHome===null?'local_selection_required':prior?.active&&prior.localHome===entry.localHome&&PROFILE_STATES.has(prior.state)&&!['stopped','apply_failed','local_selection_required'].includes(prior.state)?prior.state:'tracking';database.prepare('DELETE FROM profile_assignments WHERE binding_id=?').run(entry.bindingId);insert.run(entry.bindingId,entry.accountId,entry.name,entry.mode,entry.origin,entry.localHome,entry.launcherName,1,desired.revision,desired.revision,runtimeState,prior?.createdAt??now,now,entry.selectionKey??null);}
      database.prepare(`DELETE FROM existing_home_selections WHERE NOT EXISTS(SELECT 1 FROM profile_assignments a WHERE a.active=1 AND a.mode='existing' AND a.binding_id=existing_home_selections.binding_id AND a.selection_key=existing_home_selections.selection_key)`).run();
      state(database,'applied_local_selection_revision',localRevision,clock);
      state(database,'applied_config_revision',desired.revision,clock);state(database,'configuration_status','healthy',clock);state(database,'configuration_error_kind','',clock);database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
    return{applied:true,...configurationState(database)};
  }catch(error){
    // Local selection may fail after this declarative revision was already
    // applied (as unresolved). Do not manufacture a failed remote revision:
    // that state is invalid on the wire and would prevent remote recovery.
    const localFailure=desired.revision===currentApplied;
    if(localFailure)database.prepare(`UPDATE profile_assignments SET state='apply_failed',updated_at=?
      WHERE active=1 AND mode='existing' AND local_home IS NULL AND EXISTS(
        SELECT 1 FROM existing_home_selections s WHERE s.binding_id=profile_assignments.binding_id
        AND s.selection_key=profile_assignments.selection_key)`).run(new Date(clock()).toISOString());
    state(database,'configuration_status',localFailure?'healthy':'apply_failed',clock);state(database,'configuration_error_kind','profile_apply_failed',clock);return{applied:false,error,...configurationState(database)};
  }
}

export async function inspectLauncher(filename){return readFile(filename,'utf8');}
