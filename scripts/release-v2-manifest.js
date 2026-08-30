import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_VERSION } from '../v2/agent/config.js';

const directory=path.resolve(process.argv[2]||'dist/release-v2');
const names={ 'linux-x64':'codex-meter-agent-linux-x64', 'windows-x64':'codex-meter-agent-windows-x64.exe', 'macos-arm64':'codex-meter-agent-macos-arm64' };
const artifacts={}, checksums=[];
for(const target of Object.keys(names).sort()){
  const bytes=await readFile(path.join(directory,names[target])); const sha256=createHash('sha256').update(bytes).digest('hex');
  artifacts[target]={url:names[target],sha256,size:bytes.length}; checksums.push(`${sha256}  ${names[target]}`);
}
const manifest={schemaVersion:1,version:AGENT_VERSION,artifacts};
await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
await writeFile(path.join(directory,'SHA256SUMS'),`${checksums.join('\n')}\n`);