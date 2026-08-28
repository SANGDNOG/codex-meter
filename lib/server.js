import http from 'node:http';
import { MeterStore } from './store.js';
import { FIELDS } from './usage.js';

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
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' }); res.end(data);
}
function dashboard(data) {
  const rows = data.users.map((u) => `<tr><td>${u.id.replace(/[&<>"']/g, '')}</td><td>${u.enabled}</td><td>${u.used.total_tokens}</td></tr>`).join('');
  const policy = data.config.mode === 'observe' ? 'Observe only (no token cutoff)' : `Equal quota: ${data.config.quotaTokens} tokens`;
  return `<!doctype html><meta charset="utf-8"><title>Codex Meter</title><style>body{font:16px system-ui;max-width:900px;margin:2rem auto}table{border-collapse:collapse}td,th{padding:.5rem;border:1px solid #bbb}</style><h1>Codex Meter</h1><p>${policy}</p><table><thead><tr><th>User</th><th>Enabled</th><th>Total tokens</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function createMeterServer({ stateFile, clock }) {
  const store = new MeterStore(stateFile, clock);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'); let result;
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/v1/leases') result = await store.start(bearer(req));
      else if (req.method === 'PUT' && /^\/v1\/leases\/[^/]+$/.test(url.pathname)) result = await store.update(bearer(req), decodeURIComponent(url.pathname.split('/').at(-1)), exactUsageBody(await body(req)));
      else if (req.method === 'POST' && /^\/v1\/leases\/[^/]+\/finish$/.test(url.pathname)) result = await store.finish(bearer(req), decodeURIComponent(url.pathname.split('/')[3]), exactUsageBody(await body(req)));
      else if (req.method === 'GET' && url.pathname === '/v1/usage') result = await store.usage(bearer(req));
      else if (req.method === 'GET' && url.pathname === '/admin.json') result = await store.admin(bearer(req));
      else if (req.method === 'GET' && url.pathname === '/admin') {
        result = await store.admin(bearer(req));
        if (result.status !== 200) return send(res, result.status, result.body);
        return send(res, 200, dashboard(result.body), 'text/html; charset=utf-8');
      }
      else return send(res, 404, { error: 'not_found' });
      return send(res, result.status, result.body);
    } catch (e) { return send(res, e.message === 'body_too_large' ? 413 : 400, { error: 'bad_request' }); }
  });
}
