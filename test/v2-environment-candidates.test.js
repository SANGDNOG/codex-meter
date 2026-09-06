import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { assertCandidateUnchanged, defaultEnvironmentSearch, findEnvironmentCandidates, localDirectoryInput, sameLocalDirectoryPath } from '../v2/agent/environment-candidates.js';

async function fixture(run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meter-candidates-'));
  const root = await realpath(temporary);
  try { await run(root); } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('Candidate search defaults name exact locations without scanning a Home', () => {
  const home = path.resolve('test-user');
  assert.deepEqual(defaultEnvironmentSearch(home), { roots: [path.join(home, '.codex-home'), path.join(home, '.codex-profiles')], direct: [path.join(home, '.codex')] });
  assert.throws(() => localDirectoryInput('bad\npath'), /directory/);
  assert.equal(sameLocalDirectoryPath('C:\\Users\\Person\\Profile', 'c:\\users\\person\\profile', 'win32'), true);
  assert.equal(sameLocalDirectoryPath('/Profiles/Work', '/profiles/work', 'linux'), false);
  assert.equal(sameLocalDirectoryPath('C:\\Users\\Person\\A', 'C:\\Users\\Person\\B', 'win32'), false);
});

test('Explicit search lists immediate directories only without opening credentials, config, sessions, or launchers', () => fixture(async root => {
  const parent = path.join(root, 'profiles'), first = path.join(parent, 'alpha'), second = path.join(parent, 'beta');
  await mkdir(path.join(first, 'nested'), { recursive: true }); await mkdir(second);
  await writeFile(path.join(first, 'auth.json'), 'private fixture');
  await writeFile(path.join(first, 'config.toml'), 'private fixture');
  await writeFile(path.join(parent, 'launcher'), 'do not execute');
  const originalRead = fsPromises.readFile, originalOpen = fsPromises.open, originalOpendir = fsPromises.opendir;
  const visited = [];
  fsPromises.readFile = fsPromises.open = async () => { throw new Error('File contents must not be opened'); };
  fsPromises.opendir = async (...args) => { visited.push(args[0]); return originalOpendir(...args); };
  syncBuiltinESMExports();
  try {
    const result = await findEnvironmentCandidates({ roots: [parent, parent], direct: [first] });
    assert.deepEqual(result.candidates, [first, second]); assert.equal(result.unavailable, 0);
    assert.deepEqual(visited, [parent, parent]);
    assert.equal(result.truncated, false);
  } finally {
    fsPromises.readFile = originalRead; fsPromises.open = originalOpen; fsPromises.opendir = originalOpendir; syncBuiltinESMExports();
  }
  assert.deepEqual((await readdir(second)), []);
}));

test('Directory symlinks and missing search locations are not followed', () => fixture(async root => {
  const parent = path.join(root, 'profiles'), outside = path.join(root, 'outside');
  await mkdir(parent); await mkdir(outside);
  await symlink(outside, path.join(parent, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await findEnvironmentCandidates({ roots: [parent, path.join(root, 'missing')], direct: [path.join(parent, 'linked')] });
  assert.deepEqual(result.candidates, []); assert.equal(result.unavailable, 1);
}));

test('Local search is bounded and rejects excessive scope', () => fixture(async root => {
  for (const name of ['a', 'b', 'c']) await mkdir(path.join(root, name));
  const result = await findEnvironmentCandidates({ roots: [root], maxCandidates: 1 });
  assert.equal(result.candidates.length, 1); assert.equal(result.truncated, true);
  const limited = await findEnvironmentCandidates({ roots: [root], maxEntries: 1 });
  assert.equal(limited.candidates.length, 1); assert.equal(limited.truncated, true);
  await assert.rejects(findEnvironmentCandidates({ roots: Array(17).fill(root) }), /at most 16/);
}));

test('Shell metacharacters and spaces remain literal directory names', () => fixture(async root => {
  const home = path.join(root, 'account $(never-execute) & space'); await mkdir(home);
  assert.deepEqual((await findEnvironmentCandidates({ roots: [root] })).candidates, [home]);
}));

test('Candidate identities retain BigInt precision and unchanged candidates remain selectable',()=>fixture(async root=>{
  const home=path.join(root,'selected');await mkdir(home);const oldLstat=fsPromises.lstat;
  fsPromises.lstat=async(filename,...args)=>{
    const info=await oldLstat(filename,...args);
    if(filename===home){assert.equal(args[0]?.bigint,true);info.dev=9007199254740993n;info.ino=9007199254740995n;}
    return info;
  };syncBuiltinESMExports();
  try{
    const candidate=(await findEnvironmentCandidates({roots:[],direct:[home]})).identities.get(home);
    assert.equal(candidate.dev,'9007199254740993');assert.equal(candidate.ino,'9007199254740995');
    await assertCandidateUnchanged(candidate);
    await assert.rejects(assertCandidateUnchanged({...candidate,ino:'9007199254740994'}),{code:'candidate_changed'});
    await assert.rejects(assertCandidateUnchanged({...candidate,birthtimeNs:String(BigInt(candidate.birthtimeNs)+1n)}),{code:'candidate_changed'});
  }finally{fsPromises.lstat=oldLstat;syncBuiltinESMExports();}
}));

test('Candidate lacking a usable creation identity is not auto-approved or listed',()=>fixture(async root=>{
  const home=path.join(root,'selected');await mkdir(home);const oldLstat=fsPromises.lstat;
  fsPromises.lstat=async(filename,...args)=>{const info=await oldLstat(filename,...args);if(filename===home&&args[0]?.bigint)info.birthtimeNs=0n;return info;};syncBuiltinESMExports();
  try{assert.deepEqual((await findEnvironmentCandidates({roots:[],direct:[home]})).candidates,[]);}
  finally{fsPromises.lstat=oldLstat;syncBuiltinESMExports();}
}));
