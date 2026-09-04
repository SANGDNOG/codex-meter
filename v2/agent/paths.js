import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function canonicalHome(value,{platform=process.platform,seen=new Set()}={}) {
  const resolved=path.resolve(value),parsed=path.parse(resolved),segments=resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current=parsed.root;
  for(let index=0;index<segments.length;index++){
    const candidate=path.join(current,segments[index]);
    try{
      const stat=await lstat(candidate);
      if(stat.isSymbolicLink()){
        const target=path.resolve(path.dirname(candidate),await readlink(candidate));
        if(seen.has(target))throw new Error('CODEX_HOME contains a symbolic-link cycle');
        current=await canonicalHome(target,{platform,seen:new Set([...seen,target])});
      }else current=candidate;
    }catch(error){
      if(error?.code!=='ENOENT'&&error?.code!=='ENOTDIR')throw error;
      current=path.join(current,...segments.slice(index));
      break;
    }
  }
  try{current=await realpath(current);}catch(error){if(error?.code!=='ENOENT'&&error?.code!=='ENOTDIR')throw error;}
  return platform==='win32'?current.toLowerCase():current;
}

export function homesOverlap(left,right){return left===right||left.startsWith(`${right}${path.sep}`)||right.startsWith(`${left}${path.sep}`);}
