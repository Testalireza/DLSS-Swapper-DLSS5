'use strict';

/**
 * Browser dev-preview server (zero dependencies).
 *
 * Serves the exact same renderer the Electron app loads, and exposes the
 * exact same core services through HTTP:
 *
 *   POST /ipc        {channel, payload}  → shared IPC handler registry
 *   GET  /events     Server-Sent Events  → progress pushes (ops, scan, downloads)
 *   GET  /*          static renderer files
 *
 * Desktop-only hooks (native dialogs, shell.openPath) degrade to
 * browserMode:true responses; the renderer reacts by showing manual path
 * entry instead. Everything else — game scanning of custom folders, PE
 * analysis, backups, installs, restores, hashing — runs for real against the
 * local filesystem, which is what makes this preview a genuine test surface.
 */

const http = require('http');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const { AppEnv } = require(path.join(repoRoot, 'src', 'core', 'env'));
const { createServices } = require(path.join(repoRoot, 'src', 'core', 'app-services'));
const { createIpcHandlers, wrapAll } = require(path.join(repoRoot, 'src', 'main', 'ipc-handlers'));

const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '0.0.0.0';
// Repo-local by default (gitignored) so `npm run seed-demo` + `npm run webdev`
// share one demo dataset; override with DLSS5SWAPPER_DATA for real use.
const DATA_DIR = process.env.DLSS5SWAPPER_DATA || path.join(repoRoot, '.dlss5swapper-data');
const RENDERER_DIR = path.join(repoRoot, 'src', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function main() {
  const env = new AppEnv({ dataDir: DATA_DIR, resourcesDir: path.join(repoRoot, 'resources') });
  await env.ensureDirs();
  const services = createServices({ env });
  await services.logger.info(`DLSS Swapper 5 dev-preview server starting (data: ${DATA_DIR})`);

  // SSE clients
  const sseClients = new Set();
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  };

  const hooks = {
    isElectron: false,
    async openPath(p) { return { ok: false, browserMode: true, path: p, hint: 'Opening folders requires the Electron build.' }; },
    async showItemInFolder(p) { return { ok: false, browserMode: true, path: p }; },
    async pickFolder() { return { canceled: false, browserMode: true }; },
    async pickFiles() { return { canceled: false, browserMode: true }; },
    async pickSaveFile(opts) { return { canceled: false, browserMode: true, defaultPath: opts && opts.defaultPath }; },
  };

  const handlers = wrapAll(createIpcHandlers(services, hooks), services.logger);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // --- IPC endpoint ---
    if (url.pathname === '/ipc' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let msg;
      try { msg = JSON.parse(body || '{}'); } catch { res.writeHead(400).end('bad json'); return; }
      const handler = handlers[msg.channel];
      if (!handler) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `unknown channel: ${msg.channel}` }));
        return;
      }
      const result = await handler(msg.payload || {}, {
        emit: (channel, data) => broadcast(channel, data),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result === undefined ? null : result));
      return;
    }

    // --- SSE events ---
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('event: hello\ndata: {"ok":true}\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // --- health ---
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dataDir: DATA_DIR, version: require(path.join(repoRoot, 'package.json')).version }));
      return;
    }

    // --- static renderer ---
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const normalized = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(RENDERER_DIR, normalized);
    if (!filePath.startsWith(RENDERER_DIR)) { res.writeHead(403).end('forbidden'); return; }

    // ../shared/*.js (UMD modules) are referenced from index.html — serve them
    // from src/shared. resources/* (icons, manifests) resolve from repoRoot.
    let resolved = filePath;
    if (!fs.existsSync(resolved)) {
      const relNorm = normalized.replace(/^[/\\]+/, ''); // drop leading slash before prefix checks
      const sharedAlt = path.join(repoRoot, 'src', relNorm);
      const resAlt = path.join(repoRoot, relNorm);
      if (relNorm.startsWith(`shared${path.sep}`) && sharedAlt.startsWith(path.join(repoRoot, 'src', 'shared')) && fs.existsSync(sharedAlt)) {
        resolved = sharedAlt;
      } else if (relNorm.startsWith(`resources${path.sep}`) && resAlt.startsWith(path.join(repoRoot, 'resources')) && fs.existsSync(resAlt)) {
        resolved = resAlt;
      }
    }

    try {
      const stat = await fsp.stat(resolved);
      if (stat.isDirectory()) resolved = path.join(resolved, 'index.html');
      const ext = path.extname(resolved).toLowerCase();
      let content = await fsp.readFile(resolved);
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': content.length,
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'",
      };
      if (ext === '.html') {
        // Tell the renderer it runs in browser-preview mode.
        content = Buffer.from(
          content.toString('utf8').replace('</head>', '<script>window.__DLSS5_WEB__ = true;</script>\n</head>')
        );
        headers['Content-Length'] = content.length;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`DLSS Swapper 5 dev preview: http://${HOST}:${PORT} (data dir: ${DATA_DIR})`);
  });
}

main().catch((err) => {
  console.error('dev-preview server failed to start:', err);
  process.exit(1);
});
