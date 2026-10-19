'use strict';
// Local REST API for print integrations. Listens on 127.0.0.1 only, requires a bearer token,
// rejects browser (Origin) requests and foreign Host headers (DNS-rebinding protection).

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY = 5 * 1024 * 1024;
const RATE_LIMIT = 120; // requests per minute

function tokenMatches(expected, header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!match || !expected) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body is larger than 5 MB.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * handlers: { health(), templates(), printers(), createJob(body) → job, getJob(id), listJobs(), cancelJob(id) }
 * getToken(): current token
 */
function createApiServer({ port, getToken, handlers, log }) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const host = String(req.headers.host || '').toLowerCase();
      const allowedHosts = ['127.0.0.1:' + port, 'localhost:' + port];
      if (!allowedHosts.includes(host)) return send(res, 421, { error: 'Unknown host.' });
      if (req.headers.origin) return send(res, 403, { error: 'Browser requests are not allowed.' });
      const now = Date.now();
      while (hits.length && hits[0] < now - 60_000) hits.shift();
      if (hits.length >= RATE_LIMIT) return send(res, 429, { error: 'Too many requests.' });
      hits.push(now);
      if (!tokenMatches(getToken(), req.headers.authorization)) return send(res, 401, { error: 'Missing or invalid token. Send "Authorization: Bearer <token>" from the app\'s Automation settings.' });

      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v1') return send(res, 404, { error: 'Not found.' });
      const resource = parts[2];
      const id = parts[3];
      if (req.method === 'GET' && resource === 'health') return send(res, 200, await handlers.health());
      if (req.method === 'GET' && resource === 'templates') return send(res, 200, await handlers.templates());
      if (req.method === 'GET' && resource === 'printers') return send(res, 200, await handlers.printers());
      if (resource === 'jobs') {
        if (req.method === 'GET' && !id) return send(res, 200, await handlers.listJobs());
        if (req.method === 'GET' && id) { const job = await handlers.getJob(id); return job ? send(res, 200, job) : send(res, 404, { error: 'Job not found.' }); }
        if (req.method === 'DELETE' && id) { const job = await handlers.cancelJob(id); return job ? send(res, 200, job) : send(res, 409, { error: 'Job cannot be cancelled (not found or already running/finished).' }); }
        if (req.method === 'POST' && !id) {
          if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json.' });
          let body;
          try { body = JSON.parse(await readBody(req)); } catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Body is not valid JSON.' }); }
          const job = await handlers.createJob(body);
          return send(res, 202, job);
        }
      }
      return send(res, 405, { error: 'Method not allowed.' });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message || 'Request failed.' });
    } finally {
      log?.({ level: 'info', message: 'API ' + req.method + ' ' + String(req.url).split('?')[0] + ' → ' + res.statusCode + ' (' + (Date.now() - started) + ' ms)' });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() { return new Promise((resolve) => server.close(() => resolve())); }
  };
}

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

module.exports = { createApiServer, tokenMatches, newToken };
