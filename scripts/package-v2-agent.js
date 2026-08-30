import { build } from 'esbuild';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const targetMap = { 'linux-x64': ['linux','x64'], 'windows-x64': ['win32','x64'], 'macos-arm64': ['darwin','arm64'] };
const target = process.env.CODEX_METER_RELEASE_TARGET;
if (!targetMap[target]) throw new Error('CODEX_METER_RELEASE_TARGET must be linux-x64, windows-x64, or macos-arm64');
if (process.platform !== targetMap[target][0] || process.arch !== targetMap[target][1]) throw new Error(`SEA must be built natively for ${target}`);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 15)) throw new Error('Agent SEA packaging requires Node.js 24.15+');
const outputDir = path.resolve(process.env.CODEX_METER_RELEASE_OUT || path.join(root, 'dist', target));
const filename = target === 'windows-x64' ? 'codex-meter-agent-windows-x64.exe' : `codex-meter-agent-${target}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-meter-sea-'));
function run(command, args) { return new Promise((resolve, reject) => { const child=spawn(command,args,{stdio:'inherit'}); child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`))); }); }
async function sql(kind) { return Promise.all((await readdir(path.join(root,'v2','migrations',kind))).filter(x=>x.endsWith('.sql')).sort().map(async filename=>({filename,sql:await readFile(path.join(root,'v2','migrations',kind,filename),'utf8')}))); }
try {
  await mkdir(outputDir,{recursive:true});
  const entry=path.join(temporary,'entry.js'), bundle=path.join(temporary,'agent.cjs'), blob=path.join(temporary,'sea-prep.blob'), executable=path.join(outputDir,filename);
  const embedded={agent:await sql('agent'),server:await sql('server')};
  await writeFile(entry,`import { setEmbeddedMigrations } from ${JSON.stringify(path.join(root,'v2/shared/sqlite.js'))};\nimport { runAgentCli } from ${JSON.stringify(path.join(root,'v2/agent/cli.js'))};\nsetEmbeddedMigrations(${JSON.stringify(embedded)});\nrunAgentCli().then(code=>{process.exitCode=code}).catch(error=>{console.error(error?.message??'agent command failed');process.exitCode=1});\n`);
  await build({entryPoints:[entry],outfile:bundle,bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:sqlite'],
    define:{'import.meta.url':JSON.stringify(pathToFileURL(path.join(root,'v2/agent/database.js')).href)},logLevel:'info'});
  const seaConfig=path.join(temporary,'sea-config.json');
  await writeFile(seaConfig,JSON.stringify({main:bundle,output:blob,disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false}));
  await run(process.execPath,['--experimental-sea-config',seaConfig]);
  await copyFile(process.execPath,executable); if(process.platform!=='win32')await chmod(executable,0o755);
  if(process.platform==='darwin')await run('codesign',['--remove-signature',executable]);
  const postject=path.join(root,'node_modules','.bin',process.platform==='win32'?'postject.cmd':'postject');
  const args=[executable,'NODE_SEA_BLOB',blob,'--sentinel-fuse','NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if(process.platform==='darwin')args.push('--macho-segment-name','NODE_SEA');
  await run(postject,args);
  if(process.platform==='darwin')await run('codesign',['--sign','-','--force',executable]);
  console.log(executable);
} finally { await rm(temporary,{recursive:true,force:true}); }