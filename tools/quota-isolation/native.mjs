import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, lutimes, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ReadOnlyAppServerClient } from '../../v2/agent/app-server.js';

const command=process.env.CODEX_METER_TEST_CODEX;
if(!command||!path.isAbsolute(command))throw new Error('Set CODEX_METER_TEST_CODEX to an explicitly supplied real Codex executable.');
async function metadata(home,names){
  const rows=[];
  for(const name of names){const info=await lstat(path.join(home,name));rows.push([name,info.ino,info.mode,info.size,info.atimeMs,info.mtimeMs,info.ctimeMs]);}
  return rows;
}
for(const hasId of [false,true])test(`Real Codex startup with protected synthetic Home: installation_id ${hasId?'present':'missing'}`,async()=>{
  const root=await mkdtemp('/var/tmp/meter-native-quota-'),home=path.join(root,'selected');await mkdir(home);
  const shared=path.join(root,'shared.toml');await writeFile(shared,'# synthetic shared configuration\n');await symlink(shared,path.join(home,'config.toml'));
  if(hasId){await writeFile(path.join(home,'installation_id'),'11111111-1111-4111-8111-111111111111');await chmod(path.join(home,'installation_id'),0o600);}
  const names=['',...(await readdir(home,{recursive:true})).sort()];
  await lutimes(path.join(home,'config.toml'),new Date(0),new Date(0));
  const before=await metadata(home,names),sharedBefore=await lstat(shared);
  const client=new ReadOnlyAppServerClient({readOnlyHome:true,codexHome:home,command,timeoutMs:5000});
  try{
    await client.start();assert.equal(Boolean(await client.isAuthenticated()),false,'fixture must not acquire real credentials');
    await assert.rejects(client.readRateLimits());
  }finally{await client.close();}
  try{assert.deepEqual(await metadata(home,names),before);assert.deepEqual(['',...(await readdir(home,{recursive:true})).sort()],names);assert.equal((await lstat(shared)).mtimeMs,sharedBefore.mtimeMs);}
  finally{await rm(root,{recursive:true,force:true});}
});

for(const invalid of ['malformed','missing-resource'])test(`Real Codex cannot silently replace selected ${invalid} config with defaults`,async()=>{
  const root=await mkdtemp('/var/tmp/meter-native-quota-invalid-'),home=path.join(root,'selected');await mkdir(home);
  const config=path.join(home,'config.toml');
  const resource=path.join(root,'external-instructions.md');
  if(invalid==='missing-resource')await writeFile(resource,'Synthetic required instructions, deliberately outside the protected view.\n');
  await writeFile(config,invalid==='malformed'?'invalid = [\n':`model_instructions_file = ${JSON.stringify(resource)}\n`);
  const names=['','config.toml'],before=await metadata(home,names);
  const client=new ReadOnlyAppServerClient({readOnlyHome:true,codexHome:home,command,timeoutMs:5000});
  try{await assert.rejects(client.start(),{kind:'write_isolation_failed'});}
  finally{await client.close();}
  try{assert.deepEqual(await metadata(home,names),before);assert.deepEqual(['',...(await readdir(home)).sort()],names);}
  finally{await rm(root,{recursive:true,force:true});}
});
