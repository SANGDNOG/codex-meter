import http from 'node:http';
import { MeterStore } from './store.js';
import { FIELDS } from './usage.js';
import { landingPage, uiScript } from './ui.js';

function bearer(req) { const m = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || ''); return m?.[1] || ''; }
async function body(req) {
  const parts = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new Error('body_too_large'); parts.push(chunk); }
  return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
}
function exactUsageBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'usage')) throw new Error('invalid_schema');
  const usage = value.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('invalid_schema');
  const keys = Object.keys(usage);
  if (keys.length !== FIELDS.length || !FIELDS.every((key) => Object.hasOwn(usage, key))) throw new Error('invalid_schema');
  for (const key of FIELDS) if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error('invalid_schema');
  return usage;
}
function send(res, status, value, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? `${JSON.stringify(value)}\n` : value;
  const headers = {
    'content-type': type, 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY'
  };
  res.writeHead(status, headers); res.end(data);
}

export function createMeterServer({ stateFile, clock }) {
  const store = new MeterStore(stateFile, clock);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'); let result;
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) return send(res, 200, landingPage(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/ui.js') return send(res, 200, uiScript, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/v1/leases') result = await store.start(bearer(req));
      else if (req.method === 'PUT' && /^\/v1\/leases\/[^/]+$/.test(url.pathname)) result = await store.update(bearer(req), decodeURIComponent(url.pathname.split('/').at(-1)), exactUsageBody(await body(req)));
      else if (req.method === 'POST' && /^\/v1\/leases\/[^/]+\/finish$/.test(url.pathname)) result = await store.finish(bearer(req), decodeURIComponent(url.pathname.split('/')[3]), exactUsageBody(await body(req)));
      else if (req.method === 'GET' && url.pathname === '/v1/usage') result = await store.usage(bearer(req));
      else if (req.method === 'GET' && url.pathname === '/admin.json') result = await store.admin(bearer(req));
      else return send(res, 404, { error: 'not_found' });
      return send(res, result.status, result.body);
    } catch (e) { return send(res, e.message === 'body_too_large' ? 413 : 400, { error: 'bad_request' }); }
  });
}
