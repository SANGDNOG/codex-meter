import { createInterface } from 'node:readline/promises';
import { openSync, closeSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import path from 'node:path';
import os from 'node:os';
import { AgentCollector } from './collector.js';
import { assignmentRows, validateDesiredConfiguration } from './assignments.js';
import { discoverExistingRollouts, validateExistingHome, validateExistingSelection } from './existing-home.js';
import { profileRootKey, readExistingRoot, rootIdentityMatches } from './existing-root.js';
import { assertCandidateUnchanged, defaultEnvironmentSearch, findEnvironmentCandidates, localDirectoryInput, sameLocalDirectoryPath } from './environment-candidates.js';

const terminalName=name=>name.replace(/[\x00-\x1f\x7f-\x9f]/gu,'?');
const terminalPath=value=>JSON.stringify(value).replace(/[\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,'?');

async function chooseLocalCandidate(ask,output,searchRoots){
  const locations=searchRoots?.length?{roots:searchRoots.map(localDirectoryInput),direct:[]}:defaultEnvironmentSearch();
  output.write('Local search only: immediate child directories, no credential inspection. Candidates are not verified accounts.\n');
  for(const root of locations.roots)output.write(`Search folder: ${terminalPath(root)}\n`);
  for(const home of locations.direct)output.write(`Check directory: ${terminalPath(home)}\n`);
  const result=await findEnvironmentCandidates(locations);
  result.candidates.forEach((home,index)=>output.write(`${index+1}. ${terminalPath(home)}\n`));
  if(!result.candidates.length)output.write('No candidate directories found.\n');
  if(result.unavailable)output.write('Some locations were unavailable or linked; enter their exact path manually if needed.\n');
  if(result.truncated)output.write('Search limit reached. Use a narrower --search-root or enter a path manually.\n');
  output.write('0. Enter a path manually\nc. Cancel without attaching\n');
  const choice=await ask('Environment number (or c to cancel): ');
  if(choice==='c')return null;
  if(choice==='0')return ask('Existing Codex environment path: ');
  if(!/^[1-9][0-9]*$/.test(choice)||!result.candidates[Number(choice)-1])throw new Error('Choose a listed environment number.');
  return result.identities.get(result.candidates[Number(choice)-1]);
}
export function pendingExistingProfiles(database){
  const raw=database.prepare("SELECT value FROM agent_state WHERE key='desired_configuration'").get()?.value;
  if(!raw)return[];
  const desired=validateDesiredConfiguration(JSON.parse(raw));
  return desired.profiles.filter(profile=>{
    if(profile.mode!=='existing')return false;
    const selection=database.prepare('SELECT canonical_home FROM existing_home_selections WHERE binding_id=? AND account_id=? AND selection_key=?').get(profile.bindingId,profile.accountId,profile.selectionKey);
    return !selection||!readExistingRoot(database,profileRootKey(profile),selection.canonical_home);
  });
}

export async function attachExistingHome(database,config,profile,input,expectedCandidate=null){
  if(typeof input!=='string')throw new Error('Enter an existing environment directory.');
  const pending=pendingExistingProfiles(database),selected=pending.find(entry=>entry.bindingId===profile.bindingId&&entry.accountId===profile.accountId&&entry.selectionKey===profile.selectionKey);
  if(!selected)throw new Error('This profile no longer needs local selection. Refresh its status and try again.');
  const entered=input==='~'?os.homedir():input.startsWith(`~${path.sep}`)?path.join(os.homedir(),input.slice(2)):input;
  if(expectedCandidate)await assertCandidateUnchanged(expectedCandidate);
  const others=assignmentRows(database).filter(entry=>entry.accountId!==selected.accountId).map(entry=>entry.localHome);
  const {home,rootIdentity}=await validateExistingSelection(entered,others);
  if(expectedCandidate&&!sameLocalDirectoryPath(home,expectedCandidate.path))throw new Error('The listed environment changed. Search again.');
  const collector=new AgentCollector(database,{home,accountId:selected.accountId,bindingKey:profileRootKey(selected),rootIdentity,discovery:discoverExistingRollouts});
  // This happens before publishing the selection, so the Runtime cannot collect
  // historical events while local attachment is still establishing its baseline.
  const now=new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try{
    if(!pendingExistingProfiles(database).some(entry=>entry.bindingId===selected.bindingId&&entry.selectionKey===selected.selectionKey))throw new Error('The profile changed during local selection. Try again.');
    const currentOthers=[...assignmentRows(database).filter(entry=>entry.accountId!==selected.accountId).map(entry=>entry.localHome),...database.prepare('SELECT canonical_home FROM existing_home_selections WHERE account_id<>?').all(selected.accountId).map(row=>row.canonical_home)];
    const checked=await validateExistingSelection(home,currentOthers);
    if(!rootIdentityMatches(rootIdentity,home,checked.rootIdentity))throw new Error('The selected environment location changed.');
    if(expectedCandidate)await assertCandidateUnchanged(expectedCandidate);
    await collector.baselineCurrent({withinTransaction:true});
    if(expectedCandidate)await assertCandidateUnchanged(expectedCandidate);
    database.prepare('INSERT OR REPLACE INTO existing_home_selections(binding_id,account_id,selection_key,canonical_home,selected_at) VALUES(?,?,?,?,?)').run(selected.bindingId,selected.accountId,selected.selectionKey,home,now);
    database.prepare("INSERT INTO agent_state(key,value,updated_at) VALUES('local_selection_revision','1',?) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),updated_at=excluded.updated_at").run(now);
    database.exec('COMMIT');
  }catch(error){database.exec('ROLLBACK');throw error;}
  // The running Runtime is the only assignment writer. Publishing a local
  // selection must not race its collectors, quota observations or remote apply.
  return{name:selected.name,home};
}

export async function selectExistingProfiles(database,config,{home=null,profileName=null,input=process.stdin,output=process.stdout,question=null,tryTty=false,command,discover=false,searchRoots=null}={}){
  if(home&&(discover||searchRoots?.length))throw new Error('Use either --codex-home or interactive discovery, not both.');
  if(searchRoots?.length&&!discover)throw new Error('--search-root requires --discover.');
  let pending=pendingExistingProfiles(database);
  if(!pending.length){output.write('No profiles are waiting for an existing environment.\n');return{selected:0,pending:0};}
  const descriptors=[];let ttyInput=null,ttyOutput=null,reader=null,ask=question;
  try{
    if(!ask&&!home){
      if(input.isTTY)reader=createInterface({input,output});
      else if(tryTty&&process.platform!=='win32'){
        try{const readFd=openSync('/dev/tty','r');descriptors.push(readFd);const writeFd=openSync('/dev/tty','w');descriptors.push(writeFd);ttyInput=new ReadStream(readFd);ttyOutput=new WriteStream(writeFd);reader=createInterface({input:ttyInput,output:ttyOutput,terminal:true});output=ttyOutput;}catch{/* No controlling terminal: print the exact installed command instead. */}
      }
      if(reader)ask=prompt=>reader.question(prompt);
    }
    if(!home&&!ask){output.write(`ACTION REQUIRED:\n${command}\n`);return{selected:0,pending:pending.length};}
    let selected;
    if(profileName){const matches=pending.filter(profile=>profile.name===profileName);if(matches.length!==1)throw new Error('Select an exact pending Account Profile name.');selected=matches[0];}
    else if(pending.length===1)selected=pending[0];
    else{
      if(!ask)throw new Error('Multiple profiles need selection. Run interactively, or add --profile with the exact profile name.');
      pending.forEach((profile,index)=>output.write(`${index+1}. ${terminalName(profile.name)}\n`));
      const choice=await ask('Account Profile number: ');if(!/^[1-9][0-9]*$/.test(choice)||!pending[Number(choice)-1])throw new Error('Choose a listed profile number.');selected=pending[Number(choice)-1];
    }
    output.write(`Account Profile: ${terminalName(selected.name)}\n`);
    let entered=home??(discover?await chooseLocalCandidate(ask,output,searchRoots):await ask('Existing Codex environment path (or ? to find local environments): '));
    if(entered==='?'&&!home)entered=await chooseLocalCandidate(ask,output,searchRoots);
    if(entered===null){output.write('Cancelled. No environment attached.\n');return{selected:0,pending:pending.length};}
    const expectedCandidate=typeof entered==='object'?entered:null;
    await attachExistingHome(database,config,selected,expectedCandidate?expectedCandidate.path:entered,expectedCandidate);
    output.write(`${terminalName(selected.name)}: existing environment attached. The Agent applies tracking automatically.\n`);
    pending=pendingExistingProfiles(database);
    if(pending.length)output.write(`ACTION REQUIRED:\n${command}\n`);
    return{selected:1,pending:pending.length};
  }finally{reader?.close();ttyInput?.destroy();ttyOutput?.destroy();for(const fd of descriptors)try{closeSync(fd);}catch{/* TTY stream may already own and close the descriptor. */}}
}
