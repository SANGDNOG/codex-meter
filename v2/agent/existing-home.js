import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHome, homesOverlap } from './paths.js';
import { discoverGuardedRollouts } from './existing-rollouts.js';
import { quotaScratchRoot } from './existing-quota-runner.js';
import { rootIdentityFromStat, rootIdentityMatches, validRootIdentity } from './existing-root.js';

export async function validateExistingHome(input,otherHomes=[]){
  return (await validateExistingSelection(input,otherHomes)).home;
}

export async function validateExistingSelection(input,otherHomes=[]){
  if(typeof input!=='string'||!input.trim()||/[\x00-\x1f\x7f\u2028\u2029]/u.test(input))throw new Error('Enter an existing directory path.');
  const resolved=path.resolve(input);
  const reserved=quotaScratchRoot();
  if(reserved&&homesOverlap(resolved,reserved))throw new Error('This environment overlaps Meter runtime directories and cannot be selected.');
  let info,canonical;
  try{info=await stat(resolved,{bigint:true});canonical=await realpath(resolved);}catch{throw new Error('The selected environment must be an accessible existing directory.');}
  if(!info.isDirectory())throw new Error('The selected environment must be a directory.');
  if(typeof info.dev!=='bigint'||typeof info.ino!=='bigint'||info.ino<=0n||typeof info.birthtimeNs!=='bigint'||info.birthtimeNs<=0n)throw new Error('The selected environment does not provide a reliable directory identity.');
  canonical=await canonicalHome(canonical);
  if(reserved&&homesOverlap(canonical,reserved))throw new Error('This environment overlaps Meter runtime directories and cannot be selected.');
  for(const other of otherHomes.filter(Boolean))if(homesOverlap(canonical,await canonicalHome(other)))throw new Error('This environment overlaps another tracked profile.');
  await existingRoots(canonical);
  const rootIdentity=rootIdentityFromStat(canonical,info);
  const current=await lstat(canonical,{bigint:true});
  if(!validRootIdentity(rootIdentity)||!current.isDirectory()||current.isSymbolicLink()||!rootIdentityMatches(rootIdentity,canonical,current))throw new Error('The selected environment location changed.');
  return {home:canonical,rootIdentity};
}

async function existingRoots(home){
  const roots=[];
  for(const name of ['sessions','archived_sessions']){
    const candidate=path.join(home,name);
    try{const info=await lstat(candidate);if(info.isSymbolicLink())throw new Error('Session directories must remain inside the selected environment.');if(info.isDirectory())roots.push({path:candidate,archived:name==='archived_sessions'});}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return roots;
}

export async function discoverExistingRollouts({home,hook,rootIdentity}){
  // Store the canonical root, and refuse a later root/subdirectory symlink swap.
  await assertExistingLocation(home);
  return discoverGuardedRollouts({home,hook,rootIdentity});
}

export async function assertExistingLocation(home){
  if(await validateExistingHome(home)!==home)throw new Error('The selected environment location changed.');
}
