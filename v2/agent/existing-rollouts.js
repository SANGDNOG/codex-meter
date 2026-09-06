import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { rootIdentityFromStat, rootIdentityMatches, validRootIdentity } from './existing-root.js';

const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const MAX_DIRECTORIES = 4096;
const comparePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
export class ExistingReadIsolationError extends Error {
  constructor() { super('existing_environment_changed'); this.code = 'EXISTING_READ_ISOLATION'; }
}
function fail() { throw new ExistingReadIsolationError(); }
function identity(info) {
  // Do not round a Windows file ID or a 64-bit inode through a JS Number.
  if (typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint' || info.ino <= 0n ||
      typeof info.ctimeNs !== 'bigint' || info.ctimeNs <= 0n) fail();
  return `${info.dev}:${info.ino}`;
}
function unchanged(left, right, changes = true) {
  if (identity(left) !== identity(right) || left.mode !== right.mode ||
      left.birthtimeNs !== right.birthtimeNs ||
      changes && left.ctimeNs !== right.ctimeNs) fail();
}
function unchangedFile(left, right) {
  if (!right.isFile() || right.nlink !== 1n || right.size < left.size) fail();
  // Appending changes ctime without changing the source identity. Rollout
  // files are live append streams; rejecting that would starve all profiles.
  // Parent change times still reject file/link replacement and ABA restores.
  unchanged(left, right, false);
}
function contained(root, candidate) {
  const relative = path.relative(comparePath(root), comparePath(candidate));
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

// A per-reconciliation capability. Linux opens every component relative to a
// pinned directory. Other platforms use handle identity plus before/after
// component snapshots, including change times to reject swap-and-restore.
// No file content is read until the opened handle has passed validation.
export class ExistingReadBoundary {
  constructor(home, { hook = async () => {}, rootIdentity } = {}) {
    this.home = home; this.hook = hook; this.directories = new Map();
    this.files = new Map(); this.minimumSizes = new Map(); this.absent = new Set(); this.rootHandle = null;
    this.expectedRoot = rootIdentity;
  }
  async initialize() {
    // null is an unresolved/legacy binding. Only explicit baseline attachment
    // may acquire a previously unbound identity (undefined).
    if (this.expectedRoot === null) fail();
    if (!path.isAbsolute(this.home) || path.resolve(this.home) !== this.home ||
        comparePath(await realpath(this.home)) !== comparePath(this.home)) fail();
    const info = await this.directoryInfo(this.home);
    if (this.expectedRoot !== undefined && !rootIdentityMatches(this.expectedRoot,this.home,info)) fail();
    this.rootIdentity = rootIdentityFromStat(this.home,info);
    if(!validRootIdentity(this.rootIdentity))fail();
    this.directories.set(this.home, info);
    if (process.platform === 'linux') {
      let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        for (const part of this.home.split('/').filter(Boolean)) {
          const next = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await handle.close(); handle = next;
        }
        unchanged(info, await handle.stat({bigint:true}));
        this.rootHandle = handle; handle = null;
      } finally { await handle?.close(); }
    }
    await this.validate();
    await this.hook('after-validation', {path:this.home});
  }
  async directoryInfo(filename) {
    const info = await lstat(filename, {bigint:true});
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    identity(info); return info;
  }
  async canonicalCheck(filename) {
    const canonical = await realpath(filename);
    if (!contained(this.home, canonical) || comparePath(canonical) !== comparePath(filename)) fail();
  }
  observeSize(filename, size) {
    if (typeof size === 'number') { if(!Number.isSafeInteger(size))fail();size=BigInt(size); }
    if (size > BigInt(Number.MAX_SAFE_INTEGER) || size < (this.minimumSizes.get(filename) ?? 0n)) fail();
    this.minimumSizes.set(filename,size);
  }
  async validate(onlyFile = null) {
    for (const [filename, info] of this.directories) {
      if(onlyFile && !contained(filename,onlyFile))continue;
      unchanged(info, await this.directoryInfo(filename));
      await this.canonicalCheck(filename);
    }
    if (this.rootHandle) unchanged(this.directories.get(this.home), await this.rootHandle.stat({bigint:true}));
    for (const filename of onlyFile ? [] : this.absent) {
      try { await lstat(filename); fail(); } catch(error) { if(error.code !== 'ENOENT') throw error; }
    }
    for (const [filename, info] of this.files) {
      if(onlyFile && filename !== onlyFile)continue;
      const current = await lstat(filename, {bigint:true});
      if (current.isSymbolicLink()) fail();
      unchangedFile(info, current); this.observeSize(filename,current.size); await this.canonicalCheck(filename);
    }
  }
  async openDirectory(filename) {
    await this.canonicalCheck(filename);
    // Reopen from the pinned root rather than a potentially replaced pathname.
    if (this.rootHandle) {
      let handle = await open(`/proc/self/fd/${this.rootHandle.fd}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        unchanged(this.directories.get(this.home), await handle.stat({bigint:true}));
        let current = this.home;
        for (const part of path.relative(this.home, filename).split(path.sep).filter(Boolean)) {
          const next = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await handle.close(); handle = next;
          current = path.join(current,part);
          unchanged(this.directories.get(current),await handle.stat({bigint:true}));
        }
        unchanged(this.directories.get(filename), await handle.stat({bigint:true}));
        const result = handle; handle = null; return result;
      } finally { await handle?.close(); }
    }
    // No claim that a pathname check alone provides an atomic open. A usable
    // directory FileHandle/file identity is mandatory for the portable route.
    const handle = await open(filename, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { unchanged(this.directories.get(filename), await handle.stat({bigint:true})); return handle; }
    catch(error) { await handle.close(); throw error; }
  }
  async walk(filename, archived, candidates) {
    const info = await this.directoryInfo(filename);
    if (this.directories.size >= MAX_DIRECTORIES) fail();
    this.directories.set(filename, info);
    await this.hook('before-directory-open', {path:filename});
    const handle = await this.openDirectory(filename);
    let directory;
    try {
      directory = await opendir(this.rootHandle ? `/proc/self/fd/${handle.fd}` : filename);
      await this.hook('after-directory-open', {path:filename});
      await this.validate(filename);
      for await (const entry of directory) {
        const candidate = path.join(filename, entry.name);
        // Reject links instead of letting a watcher/discovery label authorize
        // later traversal. No credentials or arbitrary Home discovery here.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await this.walk(candidate, archived, candidates);
        else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) {
          const file = await lstat(candidate, {bigint:true});
          if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.size > BigInt(Number.MAX_SAFE_INTEGER)) fail();
          identity(file); await this.canonicalCheck(candidate);
          this.files.set(candidate, file);
          this.minimumSizes.set(candidate,file.size);
          const uuid = entry.name.match(UUID_SUFFIX)?.[1]?.toLowerCase() ?? null;
          candidates.push({path:candidate, archived, compressed:entry.name.endsWith('.zst'), size:Number(file.size),
            physicalIdentity:uuid ? `rollout:${uuid}` : `inode:${file.dev}:${file.ino}`,
            representation:entry.name.replace(/\.zst$/, ''), withOpen:callback=>this.withOpen(candidate, callback)});
        }
      }
      await this.validate(filename);
    } finally {
      try {
        try { await directory?.close(); } catch(error) { if(error.code !== 'ERR_DIR_CLOSED') throw error; }
      } finally { await handle.close(); }
    }
  }
  async withOpen(filename, callback) {
    if (!this.files.has(filename)) fail();
    await this.validate(filename);
    const parent = await this.openDirectory(path.dirname(filename));
    let handle;
    try {
      await this.hook('before-file-open', {path:filename});
      handle = await open(this.rootHandle ? `/proc/self/fd/${parent.fd}/${path.basename(filename)}` : filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      await this.hook('after-file-open', {path:filename});
      const check = async () => {
        const info = await handle.stat({bigint:true});
        unchangedFile(this.files.get(filename), info); this.observeSize(filename,info.size); await this.validate(filename);
      };
      await check();
      const guardedHandle = {
        stat:async options=>{const info=await handle.stat(options);this.observeSize(filename,info.size);return info;},
        read:async (...args) => {
          await this.hook('before-read', {path:filename}); await check();
          const [result] = await Promise.all([handle.read(...args), this.hook('during-read', {path:filename})]);
          if(result.bytesRead){
            const end=BigInt(args[3])+BigInt(result.bytesRead);
            if(end>(this.minimumSizes.get(filename)??0n))this.minimumSizes.set(filename,end);
          }
          await this.hook('after-read', {path:filename}); await check();
          return result;
        }
      };
      const result = await callback(guardedHandle);
      await check(); return result;
    } finally { try { await handle?.close(); } finally { await parent.close(); } }
  }
  async close() { await this.rootHandle?.close(); this.rootHandle = null; }
}

export async function discoverGuardedRollouts({home, hook, rootIdentity} = {}) {
  const boundary = new ExistingReadBoundary(home, {hook,rootIdentity});
  try {
    await boundary.initialize();
    const candidates = [];
    for (const [name, archived] of [['sessions', false], ['archived_sessions', true]]) {
      const filename = path.join(home, name);
      try { await boundary.directoryInfo(filename); }
      catch(error) { if(error.code === 'ENOENT') { boundary.absent.add(filename); continue; } throw error; }
      await boundary.walk(filename, archived, candidates);
    }
    const selected = new Map();
    for (const item of candidates.sort((a,b)=>a.path.localeCompare(b.path))) {
      const previous = selected.get(item.physicalIdentity);
      if (!previous || previous.compressed && !item.compressed) selected.set(item.physicalIdentity, item);
    }
    await boundary.validate();
    return {
      files:[...selected.values()].filter(item=>!item.compressed).sort((a,b)=>a.physicalIdentity.localeCompare(b.physicalIdentity)),
      compressedFiles:[...selected.values()].filter(item=>item.compressed),
      compressedOnly:[...selected.values()].filter(item=>item.compressed).length,
      compressedDetected:candidates.some(item=>item.compressed),
      rootIdentity:boundary.rootIdentity,
      validate:async()=>{await boundary.hook('before-commit',{path:home});await boundary.validate();},
      close:()=>boundary.close()
    };
  } catch(error) { await boundary.close(); throw error; }
}
