import http from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeterService, ServiceError } from './service.js';
import { AGENT_CAPABILITY_HEADER, parseAgentCapabilityHeader } from '../shared/capabilities.js';

const MAX_BODY = 1024 * 1024;
const COOKIE = 'codex_meter_session';
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const INSTALL_ROOT = fileURLToPath(new URL('../install/', import.meta.url));
const STATIC = new Map([['/',['index.html','text/html; charset=utf-8']],['/index.html',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']]]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
async function staticFile(response,pathName){const entry=STATIC.get(pathName);if(!entry)return false;const value=await readFile(path.join(WEB_ROOT,entry[0]));response.writeHead(200,{'content-type':entry[1],'content-length':value.length,'cache-control':entry[0]==='index.html'?'no-store':'public, max-age=3600','content-security-policy':CSP,'x-content-type-options':'nosniff','referrer-policy':'no-referrer','permissions-policy':'camera=(), microphone=(), geolocation=()','x-frame-options':'DENY'});response.end(value);return true;}
async function installerFile(response, pathName) { const names = new Map([['/install.sh','install.sh'],['/install.ps1','install.ps1']]); const name=names.get(pathName); if(!name)return false; const value=await readFile(path.join(INSTALL_ROOT,name)); response.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-length':value.length,'cache-control':'no-store','x-content-type-options':'nosniff'});response.end(value);return true; }
async function releaseFile(response, pathName, releaseDirectory) { if (!releaseDirectory || !pathName.startsWith('/api/v1/agent/releases/')) return false; const name=decodeURIComponent(pathName.slice('/api/v1/agent/releases/'.length)); if(!/^[A-Za-z0-9._-]+$/.test(name))return false; try { const value=await readFile(path.join(releaseDirectory,name)); response.writeHead(200,{'content-type':name.endsWith('.json')?'application/json; charset=utf-8':'application/octet-stream','content-length':value.length,'cache-control':'no-store','x-content-type-options':'nosniff'});response.end(value);return true; } catch(error) { if(error.code==='ENOENT')return false; throw error; } }
function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers });
  response.end(body);
}
function cookies(header = '') { return Object.fromEntries(header.split(';').map((item) => item.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2)); }
async function body(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ServiceError(415, 'json_required');
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) throw new ServiceError(413, 'body_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError(400, 'invalid_json'); }
}
function remoteAddress(request) {
  const value = request.socket.remoteAddress ?? '';
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}
function trustedProxySet(addresses) {
  if (!Array.isArray(addresses) || addresses.some((value) => typeof value !== 'string' || !isIP(value))) throw new Error('trustedProxyAddresses must contain exact IP addresses');
  return new Set(addresses.map((value) => value.startsWith('::ffff:') ? value.slice(7) : value));
}
function secureTransport(request, trustedProxies) {
  if (request.socket.encrypted) return true;
  return trustedProxies.has(remoteAddress(request)) && request.headers['x-forwarded-proto'] === 'https';
}
function origin(request, trustedProxies) {
  const protocol = secureTransport(request, trustedProxies) ? 'https' : 'http';
  return `${protocol}://${request.headers.host}`;
}
function requireSameOrigin(request, trustedProxies) {
  if (request.headers.origin !== origin(request, trustedProxies)) throw new ServiceError(403, 'origin_mismatch');
}
function bearer(request) {
  const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{20,200})$/);
  return match ? { deviceId: match[1], secret: match[2] } : null;
}
function agentCapabilities(request) {
  const parsed=parseAgentCapabilityHeader(request.headers[AGENT_CAPABILITY_HEADER]);
  if(parsed===null)throw new ServiceError(400,'invalid_capabilities');
  return parsed;
}
function adminSession(service, request) {
  const session = service.session(cookies(request.headers.cookie)[COOKIE]);
  if (!session) throw new ServiceError(401, 'authentication_required');
  return session;
}
function requireCsrf(request, session, trustedProxies) {
  requireSameOrigin(request, trustedProxies);
  if (typeof request.headers['x-csrf-token'] !== 'string' || request.headers['x-csrf-token'] !== session.csrfToken) throw new ServiceError(403, 'csrf_failed');
}

export function createV2Server({ database, adminPassword, serverUrl = '', clock, enrollmentTtlMs, sessionTtlMs, quotaStaleMs, releaseDirectory = null, trustedProxyAddresses = ['127.0.0.1', '::1'] } = {}) {
  if (!database) throw new Error('database is required');
  const trustedProxies = trustedProxySet(trustedProxyAddresses);
  const service = new MeterService(database, { adminPassword, serverUrl, clock, enrollmentTtlMs, sessionTtlMs, quotaStaleMs });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin(request, trustedProxies)); const path = url.pathname; const method = request.method;
      if (method === 'GET' && STATIC.has(path)) { await staticFile(response,path); return; }
      if (method === 'GET' && await installerFile(response,path)) return;
      if (method === 'GET' && await releaseFile(response,path,releaseDirectory)) return;
      if (method === 'GET' && path === '/api/v1/health') return json(response, 200, service.health());
      if (method === 'POST' && path === '/api/v1/auth/login') {
        requireSameOrigin(request, trustedProxies); const input = await body(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.password !== 'string') throw new ServiceError(400, 'invalid_body');
        const result = service.login(input.password); const secure = secureTransport(request, trustedProxies) ? '; Secure' : '';
        return json(response, 200, { authenticated: true, csrfToken: result.csrfToken }, { 'set-cookie': `${COOKIE}=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Strict${secure}` });
      }
      if (method === 'POST' && path === '/api/v1/agent/enroll') {
        if (!secureTransport(request, trustedProxies)) throw new ServiceError(426, 'https_required');
        return json(response, 201, service.enroll(await body(request),agentCapabilities(request)));
      }
      if (method === 'POST' && path === '/api/v1/agent/sync') {
        if (!secureTransport(request, trustedProxies)) throw new ServiceError(426, 'https_required');
        const credentials = bearer(request); const device = credentials && service.authenticateDevice(credentials.deviceId, credentials.secret);
        if (!device) throw new ServiceError(401, 'invalid_device_credential');
        return json(response, 200, service.sync(device, await body(request),agentCapabilities(request)));
      }
      const session = adminSession(service, request);
      if (method === 'GET' && path === '/api/v1/auth/session') return json(response, 200, { authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
      if (!['GET', 'HEAD'].includes(method)) requireCsrf(request, session, trustedProxies);
      if (method === 'POST' && path === '/api/v1/auth/logout') { service.logout(session.id); const secure=secureTransport(request, trustedProxies)?'; Secure':''; return json(response, 200, { authenticated: false }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0` }); }
      if (method === 'GET' && path === '/api/v1/groups') return json(response, 200, { groups: service.listGroups() });
      if (method === 'POST' && path === '/api/v1/groups') return json(response, 201, service.createGroup(await body(request)));
      let match = path.match(/^\/api\/v1\/groups\/([^/]+)$/);
      if (match && method === 'PATCH') return json(response, 200, service.updateGroup(decodeURIComponent(match[1]), await body(request)));
      if (match && method === 'DELETE') return json(response, 200, service.updateGroup(decodeURIComponent(match[1]), { archived: true }));
      if (method === 'GET' && path === '/api/v1/accounts') return json(response, 200, { accounts: service.listAccounts(url.searchParams.get('range') ?? 'all') });
      if (method === 'POST' && path === '/api/v1/accounts') return json(response, 201, service.createAccount(await body(request)));
      match = path.match(/^\/api\/v1\/accounts\/([^/]+)\/quota\/history$/);
      if (match && method === 'GET') { const raw=url.searchParams.get('limit');const limit=raw===null?100:Number(raw);return json(response,200,service.accountQuotaHistory(decodeURIComponent(match[1]),{limit,before:url.searchParams.get('before')})); }
      match = path.match(/^\/api\/v1\/accounts\/([^/]+)\/quota-attribution$/);
      if (match && method === 'GET') return json(response, 200, service.quotaAttribution(decodeURIComponent(match[1])));
      match = path.match(/^\/api\/v1\/accounts\/([^/]+)$/);
      if (match && method === 'GET') return json(response, 200, service.accountDetail(decodeURIComponent(match[1]), url.searchParams.get('range') ?? 'all'));
      if (match && method === 'PATCH') return json(response, 200, service.updateAccount(decodeURIComponent(match[1]), await body(request)));
      if (match && method === 'DELETE') return json(response, 200, service.updateAccount(decodeURIComponent(match[1]), { archived: true }));
      if (method === 'GET' && path === '/api/v1/devices') return json(response, 200, { devices: service.listDevices() });
      if (method === 'POST' && path === '/api/v1/devices') return json(response, 201, service.createDevice(await body(request)));
      match = path.match(/^\/api\/v1\/device-enrollments\/([^/]+)$/);
      if (match && method === 'GET') return json(response, 200, service.enrollmentStatus(decodeURIComponent(match[1])));
      match = path.match(/^\/api\/v1\/devices\/([^/]+)$/);
      if (match && method === 'GET') return json(response, 200, service.deviceDetail(decodeURIComponent(match[1])));
      if (match && method === 'PATCH') return json(response, 200, service.updateDevice(decodeURIComponent(match[1]), await body(request)));
      if (match && method === 'DELETE') { service.removeDevice(decodeURIComponent(match[1])); return json(response, 200, { removed: true }); }
      match = path.match(/^\/api\/v1\/devices\/([^/]+)\/account-bindings$/);
      if (match && method === 'POST') return json(response, 201, service.bindAccount(decodeURIComponent(match[1]), await body(request)));
      match = path.match(/^\/api\/v1\/devices\/([^/]+)\/account-bindings\/([^/]+)$/);
      if (match && method === 'DELETE') return json(response, 200, service.disableBinding(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
      match = path.match(/^\/api\/v1\/devices\/([^/]+)\/configuration\/rollback$/);
      if (match && method === 'POST') return json(response, 200, service.rollbackConfiguration(decodeURIComponent(match[1]), await body(request)));
      match = path.match(/^\/api\/v1\/devices\/([^/]+)\/(move|disable|rotate)$/);
      if (match && method === 'POST') {
        const deviceId = decodeURIComponent(match[1]);
        if (match[2] === 'move') return json(response, 200, service.moveDevice(deviceId, await body(request)));
        if (match[2] === 'disable') { const input = await body(request); if (!input || Object.keys(input).some((key)=>key!=='disabled')) throw new ServiceError(400,'invalid_body'); return json(response, 200, service.disableDevice(deviceId, input.disabled ?? true)); }
        return json(response, 200, service.rotateDevice(deviceId));
      }
      if (method === 'GET' && path === '/api/v1/usage/summary') return json(response, 200, service.summary(url.searchParams.get('range') ?? 'today'));
      if (method === 'GET' && path === '/api/v1/quota/current') return json(response, 200, service.quotaCurrent());
      match = path.match(/^\/api\/v1\/usage\/(groups|devices)\/([^/]+)$/);
      if (match && method === 'GET') {
        const key = match[1] === 'groups' ? 'groupId' : 'deviceId'; const value = decodeURIComponent(match[2]);
        if (key === 'groupId' && !service.database.prepare('SELECT id FROM groups WHERE id=?').get(value)) throw new ServiceError(404,'group_not_found');
        if (key === 'deviceId') service.deviceDetail(value);
        return json(response, 200, service.usage(url.searchParams.get('range') ?? 'today', { [key]: value }));
      }
      if (method === 'POST' && path === '/api/v1/usage/adjustments') return json(response, 201, service.addAdjustment(await body(request), session.id));
      if (method === 'GET' && path === '/api/v1/settings') return json(response, 200, service.settings());
      if (method === 'PATCH' && path === '/api/v1/settings') return json(response, 200, service.updateSettings(await body(request)));
      throw new ServiceError(404, 'not_found');
    } catch (error) {
      if (error instanceof ServiceError) return json(response, error.status, { error: error.code, message: error.message });
      console.error('v2 request failed', error?.message ?? 'unknown error');
      return json(response, 500, { error: 'internal_error' });
    }
  });
  server.service = service;
  return server;
}
