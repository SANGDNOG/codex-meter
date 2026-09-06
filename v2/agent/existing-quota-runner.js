import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { homesOverlap } from './paths.js';
import { rootIdentityMatches } from './existing-root.js';

export class QuotaIsolationError extends Error {
  constructor() { super('write_isolation_failed'); this.kind = 'write_isolation_failed'; }
}

const TEMP_ROOT = '/tmp';
const OWNER_FILE = '.codex-meter-quota-owner';
const ROOT_MARKER = '.codex-meter-quota-root';
// Reserved for Meter runtimes, never an adoptable environment/config source.
// Do not scan the global temp directory: an old scratch may have been adopted
// by a separate CLI after a running Agent captured its protected Home list.
export const quotaScratchRoot = () => process.platform === 'linux' ? `/tmp/codex-meter-quota-runtime-${process.getuid()}` : null;
const reservedSource = source => quotaScratchRoot() && homesOverlap(source, quotaScratchRoot());

async function openScratchRoot(create = false) {
  const directory = quotaScratchRoot();
  // A linked /tmp would give the reserved lexical namespace another adoptable
  // pathname. Refuse it rather than following it while creating or reaping.
  const temp=await open(TEMP_ROOT,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
  const pinnedDirectory=`/proc/self/fd/${temp.fd}/${path.basename(directory)}`;
  let created = false;
  if (create) {
    try { await mkdir(pinnedDirectory, {mode:0o700}); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const handle = await open(pinnedDirectory, constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NOATIME);
  try {
    const info = await handle.stat();
    if(info.uid!==process.getuid()||(info.mode&0o777)!==0o700)throw new QuotaIsolationError();
    const filename=`/proc/self/fd/${handle.fd}/${ROOT_MARKER}`, expected=`codex-meter-quota-root-v1:${process.getuid()}\n`;
    if(created)await writeFile(filename,expected,{flag:'wx',mode:0o600});
    const marker=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NOATIME|constants.O_NONBLOCK);
    try {
      const meta=await marker.stat();
      if(!meta.isFile()||meta.uid!==process.getuid()||meta.nlink!==1||meta.size!==Buffer.byteLength(expected)||(meta.mode&0o777)!==0o600||await marker.readFile('utf8')!==expected)throw new QuotaIsolationError();
    } finally { await marker.close(); }
    return handle;
  } catch(error) { await handle.close(); throw error; }
  } finally { await temp.close(); }
}
const SYSTEM_ROOTS = ['/usr', '/bin', '/lib', '/lib64'];
const SYSTEM_FILES = ['/etc/ssl', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/gai.conf'];
const CODEX_SYSTEM_CONFIG = ['/etc/codex/config.toml', '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'];
const QUIET_STARTUP = ['features.plugins=false', 'skills.bundled.enabled=false',
  'features.background_paginated_rollout_migration=false', 'features.local_thread_store_compression=false',
  'otel.exporter="none"', 'otel.metrics_exporter="none"'];
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/u.test(value);

// No recursive deletion: scratch contents live in a private tmpfs, not here.
// Only empty, old, owned directories belonging to dead processes are eligible.
export async function reapQuotaScratch({ now = Date.now(), minimumAgeMs = 86400000, protectedHomes = [], sandboxCommand = '/usr/bin/bwrap' } = {}) {
  if (process.platform !== 'linux') return;
  const uid = process.getuid();
  let root, entries;
  try { root=await openScratchRoot(); entries=await opendir(`/proc/self/fd/${root.fd}`,{bufferSize:32}); }
  catch { await root?.close(); return; }
  try {
  let visited=0;
  for await (const entry of entries) {
    if(++visited>4096)break;
    const match = entry.name.match(/^codex-meter-quota-(\d+)-(\d+)-[A-Za-z0-9]{6}$/);
    if (!match || Number(match[1]) !== uid || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = `/proc/self/fd/${root.fd}/${entry.name}`;
    const logicalDirectory = path.join(quotaScratchRoot(),entry.name);
    if(protectedHomes.some(home=>typeof home==='string'&&homesOverlap(path.resolve(home),logicalDirectory)))continue;
    let handle;
    try {
      handle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NOATIME);
      const info = await handle.stat(),pinned=`/proc/self/fd/${handle.fd}`;
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700 || now - info.mtimeMs < minimumAgeMs) continue;
      try { process.kill(Number(match[2]), 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
      const marker=await open(path.join(pinned,OWNER_FILE),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_NOATIME);
      try{
        const markerInfo=await marker.stat();
        if(!markerInfo.isFile()||markerInfo.uid!==uid||markerInfo.nlink!==1||markerInfo.size>128||(markerInfo.mode&0o777)!==0o600)continue;
        if(await marker.readFile('utf8')!==`codex-meter-quota-v1:${uid}:${Number(match[2])}\n`)continue;
      }finally{await marker.close();}
      // Even rejected nonempty directories may have become external config
      // sources. Enumerate through a read-only mount, not a fresh writable FD.
      const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL'];
      for (const location of SYSTEM_ROOTS) {
        try { await lstat(location); args.push('--ro-bind', location, location); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      args.push('--proc','/proc','--dev','/dev','--ro-bind-fd','3','/source','--','/usr/bin/find','/source','-mindepth','1','-maxdepth','1','-printf','%f\\0');
      const names=await metadataOutput(sandboxCommand,args,['ignore','pipe','ignore',handle.fd]);
      if(names!==`${OWNER_FILE}\0`)continue;
      await unlink(path.join(pinned,OWNER_FILE));
      const current=await lstat(directory);if(current.isSymbolicLink()||current.dev!==info.dev||current.ino!==info.ino)continue;
      await rmdir(directory);
    } catch { /* Never remove nonempty or replaced scratch paths. */ }
    finally{await handle?.close();}
  }
  } finally { await root.close(); }
}

async function metadataOutput(sandbox, args, stdio = ['ignore', 'pipe', 'ignore'], maxBytes = 4096, allowEmpty = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(sandbox, args, { env: { LANG: 'C' }, shell: false, stdio });
    let output = Buffer.alloc(0), failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 3000); timer.unref();
    child.stdout.on('data', chunk => { if (output.length + chunk.length > maxBytes) { failed = true; child.kill('SIGKILL'); } else output = Buffer.concat([output, chunk]); });
    child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timer); if (!failed && code === 0 && (output.length || allowEmpty)) resolve(output.toString('utf8')); else reject(new QuotaIsolationError()); });
  });
}

async function executablePath(command, sandbox, home) {
  if (typeof command !== 'string' || !command) throw new QuotaIsolationError();
  const choices = command.includes(path.sep) ? [path.resolve(command)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(root => path.resolve(root, command));
  for (const candidate of choices.slice(0, 256)) {
    if (!validPath(candidate) || homesOverlap(candidate, home)) continue;
    try {
      // Only a fixed metadata utility sees this read-only host view. Codex never
      // does. Resolving npm launcher links on the writable host changes atime.
      const resolved = await metadataOutput(sandbox, ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/realpath', '-e', '-z', '--', candidate]);
      const filename = resolved.endsWith('\0') ? resolved.slice(0, -1) : '';
      if (validPath(filename) && !homesOverlap(filename, home)) return filename;
    } catch { /* Literal PATH lookup only; no launcher/shell parsing. */ }
  }
  throw new QuotaIsolationError();
}

export class ExistingHomeQuotaRunner {
  constructor({ codexHome, command = 'codex', platform = process.platform, sandboxCommand = '/usr/bin/bwrap', protectedHomes = [], rootIdentity } = {}) {
    this.home = codexHome; this.executable = command; this.platform = platform; this.sandboxCommand = sandboxCommand;
    this.handles = []; this.scratch = null;
    this.protectedHomes = protectedHomes;
    this.expectedRoot = rootIdentity;
  }

  async pin(filename, directory = false, root = null) {
    // Resolve every ancestor through a pinned directory FD with O_NOFOLLOW.
    // This also protects an external shared-config target from ancestor swaps.
    const parts = (root ? filename : path.resolve(filename)).split('/').filter(Boolean);
    let parent = await open(root ? `/proc/self/fd/${this.handles[root.fd - 3].fd}/.` : '/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (let index = 0; index < parts.length; index++) {
        const next = await open(`/proc/self/fd/${parent.fd}/${parts[index]}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (index < parts.length - 1 || directory ? constants.O_DIRECTORY : 0));
        await parent.close(); parent = next;
      }
      const info = await parent.stat();
      if (directory ? !info.isDirectory() : !info.isFile()) throw new QuotaIsolationError();
      const fd = 3 + this.handles.length; this.handles.push(parent); parent = null;
      return { fd, info };
    } finally { await parent?.close(); }
  }

  async configLink(sandbox, root) {
    // readlink on the ordinary writable filesystem can update a symlink's
    // atime. Read even this metadata through a read-only mount instead.
    const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL'];
    for (const location of SYSTEM_ROOTS) {
      try { await lstat(location); args.push('--ro-bind', location, location); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--ro-bind-fd', '3', '/source', '--', '/usr/bin/readlink', '-n', '/source/config.toml');
    return metadataOutput(sandbox, args, ['ignore', 'pipe', 'ignore', this.handles[root.fd - 3].fd]);
  }

  async assertFileAuthPolicy(sandbox, input) {
    // Inspect only non-auth TOML policy, never auth.json. All reads occur through
    // a read-only mount; content stays in memory and is never logged/persisted.
    const args = ['--die-with-parent','--new-session','--unshare-pid','--unshare-ipc','--unshare-uts','--cap-drop','ALL'];
    for (const location of SYSTEM_ROOTS) {
      try { await lstat(location); args.push('--ro-bind',location,location); } catch(error) { if(error.code!=='ENOENT')throw error; }
    }
    // Empty TOML is valid; bound the input without invoking a shell.
    args.push('--proc','/proc','--dev','/dev','--ro-bind-fd','3','/source','--','/usr/bin/head','-c','262145','/source');
    const content=await metadataOutput(sandbox,args,['ignore','pipe','ignore',this.handles[input.fd-3].fd],262144,true);
    const policy=parseToml(content),pending=[policy];
    while(pending.length){
      const value=pending.pop();
      if(!value||typeof value!=='object')continue;
      for(const [key,item] of Object.entries(value)){
        if(key==='cli_auth_credentials_store'&&item!=='file')throw new QuotaIsolationError();
        if(item&&typeof item==='object')pending.push(item);
      }
    }
  }

  async prepare() {
    try {
      // Native macOS/Windows need their own verified adapter. Never retry directly.
      if (this.platform !== 'linux' || process.platform !== 'linux' || !validPath(this.home)) throw new QuotaIsolationError();
      // A realpath() before no-follow validation would read rejected symlinks
      // and can mutate their atime. Assignments already store canonical paths.
      const home = path.resolve(this.home);
      if (home !== this.home || !path.isAbsolute(this.sandboxCommand)) throw new QuotaIsolationError();
      if(reservedSource(home))throw new QuotaIsolationError();
      if ([...SYSTEM_ROOTS, '/etc', '/proc', '/dev', '/run', TEMP_ROOT].some(root => home === root || homesOverlap(home, root) && !home.startsWith(`${TEMP_ROOT}/`))) throw new QuotaIsolationError();
      const sandbox = await realpath(this.sandboxCommand), sandboxInfo = await lstat(sandbox);
      if (!sandboxInfo.isFile() || sandboxInfo.uid !== 0 || (sandboxInfo.mode & 0o022)) throw new QuotaIsolationError();
      const root = await this.pin(home, true);
      if(this.expectedRoot!==undefined&&!rootIdentityMatches(this.expectedRoot,home,await this.handles[root.fd-3].stat({bigint:true})))throw new QuotaIsolationError();
      const files = [];
      for (const name of ['auth.json', 'config.toml']) {
        const original = path.join(home, name);
        const pinnedOriginal = `/proc/self/fd/${this.handles[root.fd - 3].fd}/${name}`;
        let found = false;
        try {
          const info = await lstat(pinnedOriginal);
          found = true;
          let target = original, link = null;
          if (info.isSymbolicLink()) {
            if (name !== 'config.toml') throw new QuotaIsolationError();
            link = await this.configLink(sandbox, root);
            // Lexical collapse of dir/.. can hide a required directory or even
            // a source symlink. Never recreate a route that changes its meaning.
            if (!link || link !== path.normalize(link) || /[\x00-\x1f\x7f]/u.test(link)) throw new QuotaIsolationError();
            target = path.resolve(home, link);
            if(reservedSource(target))throw new QuotaIsolationError();
            if(path.basename(target).toLowerCase()==='auth.json')throw new QuotaIsolationError();
            if (homesOverlap(target, home) || [...SYSTEM_ROOTS, '/etc', '/proc', '/dev', '/run'].some(location => homesOverlap(target, location))) throw new QuotaIsolationError();
          } else if (!info.isFile()) throw new QuotaIsolationError();
          const pinned = link === null ? await this.pin(name, false, root) : await this.pin(target);
          if (link === null && (info.dev !== pinned.info.dev || info.ino !== pinned.info.ino)) throw new QuotaIsolationError();
          const after = await lstat(pinnedOriginal);
          if (after.dev !== info.dev || after.ino !== info.ino || after.ctimeMs !== info.ctimeMs || (link !== null && await this.configLink(sandbox, root) !== link)) throw new QuotaIsolationError();
          files.push({ name, target, link, ...pinned });
        } catch (error) { if (found || error.code !== 'ENOENT') throw error; }
      }
      const finalRoot = await this.pin(home, true);
      if (finalRoot.info.dev !== root.info.dev || finalRoot.info.ino !== root.info.ino) throw new QuotaIsolationError();
      await this.handles[finalRoot.fd - 3].close(); this.handles[finalRoot.fd - 3] = null;
      const executable = await executablePath(this.executable, sandbox, home);
      const executablePin = await this.pin(executable);
      if (!(executablePin.info.mode & 0o111)) throw new QuotaIsolationError();
      // The supported npm launcher needs its own package/dependencies, not an
      // entire user directory. Native executables need only their own file.
      const packageRoot = path.basename(executable) === 'codex.js' && path.basename(path.dirname(executable)) === 'bin' && path.basename(path.dirname(path.dirname(executable))) === 'codex'
        ? path.dirname(path.dirname(executable)) : null;
      if (packageRoot && homesOverlap(packageRoot, home)) throw new QuotaIsolationError();
      const packagePin = packageRoot ? await this.pin(packageRoot, true) : null;
      const dependencyMounts = [];
      if (packageRoot) {
        if (!['x64', 'arm64'].includes(process.arch)) throw new QuotaIsolationError();
        const name = `codex-linux-${process.arch}`;
        // Official npm installations use a nested optional package or a sibling
        // under @openai. Never mount the whole user prefix to find dependencies.
        for (const directory of [path.join(packageRoot, 'node_modules', '@openai', name), path.join(path.dirname(packageRoot), name)]) {
          if (homesOverlap(directory, home)) throw new QuotaIsolationError();
          let dependency;
          try {
            dependency = await this.pin(directory, true);
            const manifest = await this.pin('package.json', false, dependency);
            await this.handles[manifest.fd - 3].close(); this.handles[manifest.fd - 3] = null;
            dependencyMounts.push({directory, fd:dependency.fd}); break;
          } catch (error) {
            if (dependency) { await this.handles[dependency.fd - 3].close(); this.handles[dependency.fd - 3] = null; }
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
      const systemConfig = [];
      for (const filename of CODEX_SYSTEM_CONFIG) {
        try { systemConfig.push({filename, ...await this.pin(filename)}); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // Conservative across layers: never force auto/keyring to file merely
      // because the protected runtime cannot access the original keyring.
      const auth=files.find(file=>file.name==='auth.json');
      for (const input of [...files.filter(file=>file.name==='config.toml'),...systemConfig]) {
        if(input.info.nlink!==1||auth&&input.info.dev===auth.info.dev&&input.info.ino===auth.info.ino)throw new QuotaIsolationError();
        await this.assertFileAuthPolicy(sandbox,input);
      }
      await reapQuotaScratch({protectedHomes:[home,...this.protectedHomes,...files.map(file=>file.target)],sandboxCommand:sandbox});
      this.scratchRootHandle=await openScratchRoot(true);
      const pinnedScratch=await mkdtemp(`/proc/self/fd/${this.scratchRootHandle.fd}/codex-meter-quota-${process.getuid()}-${process.pid}-`);
      this.scratch=path.join(quotaScratchRoot(),path.basename(pinnedScratch));
      this.scratchPinned=pinnedScratch;
      this.scratchIdentity=await lstat(this.scratch);
      const pinnedIdentity=await lstat(pinnedScratch);
      if(pinnedIdentity.dev!==this.scratchIdentity.dev||pinnedIdentity.ino!==this.scratchIdentity.ino)throw new QuotaIsolationError();
      await writeFile(path.join(pinnedScratch,OWNER_FILE),`codex-meter-quota-v1:${process.getuid()}:${process.pid}\n`,{flag:'wx',mode:0o600});
      if (homesOverlap(home, this.scratch)) throw new QuotaIsolationError();
      const scratch = this.scratch;
      const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL'];
      for (const location of [...SYSTEM_ROOTS, ...SYSTEM_FILES]) {
        try { await lstat(location); args.push('--ro-bind', location, location); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', scratch, '--tmpfs', home);
      for (const {filename, fd} of systemConfig) args.push('--ro-bind-fd', String(fd), filename);
      for (const { name, fd, target, link } of files) {
        if (link !== null) {
          if (target.startsWith(`${home}/`) || SYSTEM_ROOTS.some(root => homesOverlap(target, root)) || homesOverlap(target, scratch)) throw new QuotaIsolationError();
          args.push('--ro-bind-fd', String(fd), target, '--symlink', link, path.join(home, name));
        } else args.push('--ro-bind-fd', String(fd), path.join(home, name));
      }
      if (packageRoot) args.push('--ro-bind-fd', String(packagePin.fd), packageRoot);
      else if (!SYSTEM_ROOTS.some(root => executable.startsWith(`${root}/`))) args.push('--ro-bind-fd', String(executablePin.fd), executable);
      for (const {directory, fd} of dependencyMounts) args.push('--ro-bind-fd', String(fd), directory);
      if (packageRoot || SYSTEM_ROOTS.some(root => executable.startsWith(`${root}/`))) {
        await this.handles[executablePin.fd - 3].close(); this.handles[executablePin.fd - 3] = null;
      }
      args.push('--chdir', scratch);
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? scratch, LANG: 'C.UTF-8',
        CODEX_HOME: home, CODEX_SQLITE_HOME: `${scratch}/sqlite`, TMPDIR: `${scratch}/tmp`,
        XDG_CACHE_HOME: `${scratch}/cache`, XDG_CONFIG_HOME: `${scratch}/config`, XDG_DATA_HOME: `${scratch}/data` };
      args.push('--dir', env.TMPDIR);
      // Explicit sqlite_home takes precedence over a user's configured setting.
      const settings = [`sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME)}`, `log_dir=${JSON.stringify(`${scratch}/log`)}`, ...QUIET_STARTUP];
      args.push('--', executable, ...settings.flatMap(value => ['-c', value]), 'app-server', '--stdio', '--strict-config');
      // The validation-only root FD must never reach the child. Bubblewrap's
      // dedicated bind-fd operation consumes/closes the remaining source FDs.
      await this.handles[root.fd - 3].close(); this.handles[root.fd - 3] = null;
      this.launch = { command: sandbox, args, env, stdio: ['pipe', 'pipe', 'pipe', ...this.handles.map(handle => handle?.fd ?? 'ignore')], cwd: scratch };
      return this.launch;
    } catch { await this.cleanup(); throw new QuotaIsolationError(); }
  }

  async closeHandles() { await Promise.all(this.handles.splice(0).filter(Boolean).map(handle => handle.close())); }
  async cleanup() {
    await this.closeHandles();
    try {
    if (this.scratch) {
      const directory = this.scratchPinned; this.scratch = null;
      let handle;
      try {
        if(homesOverlap(this.home,directory))throw new QuotaIsolationError();
        handle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        const info=await handle.stat();if(info.dev!==this.scratchIdentity.dev||info.ino!==this.scratchIdentity.ino)throw new QuotaIsolationError();
        await unlink(`/proc/self/fd/${handle.fd}/${OWNER_FILE}`);
        const current=await lstat(directory);if(current.isSymbolicLink()||current.dev!==info.dev||current.ino!==info.ino)throw new QuotaIsolationError();
        await rmdir(directory);
      } catch (error) { if (error.code !== 'ENOENT') throw new QuotaIsolationError(); }
      finally{await handle?.close();}
    }
    } finally { await this.scratchRootHandle?.close(); this.scratchRootHandle=null; }
  }
}

// The sync wrapper must not call general canonicalization before this runner:
// following a rejected root link there already changes source metadata.
export async function assertExistingQuotaLocation(home,rootIdentity) {
  const runner = new ExistingHomeQuotaRunner({codexHome:home});
  try {
    if (process.platform !== 'linux' || !validPath(home) || path.resolve(home) !== home || reservedSource(home)) throw new QuotaIsolationError();
    const root=await runner.pin(home, true);
    if(rootIdentity!==undefined&&!rootIdentityMatches(rootIdentity,home,await runner.handles[root.fd-3].stat({bigint:true})))throw new QuotaIsolationError();
  } catch { throw new QuotaIsolationError(); }
  finally { await runner.closeHandles(); }
}
