import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiscovery } from './reports.mjs';
import { loadResearch } from './research.mjs';
import { planAgentCycle, emptyAgentState } from '../../packages/agent/index.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf' };

export function createMirServer({ dataDirectory = path.join(project, 'data/discovery'),
  researchDirectory = path.join(project, 'data/research'),
  webRoot = path.join(project, 'apps/web'), brandRoot = path.join(project, 'outputs/MIR-Brand-Kit-v2'),
  now = Date.now } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Read-only service'); return;
    }
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { response.writeHead(400); response.end('Invalid URL'); return; }
    if (url.pathname === '/api/discovery') {
      response.setHeader('Content-Type', 'application/json');
      try {
        const result = await loadDiscovery(dataDirectory, now());
        response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result));
      } catch {
        response.writeHead(503); response.end(request.method === 'HEAD' ? undefined : JSON.stringify({
          available: false, dataset: 'saved-onchain', freshness: 'unavailable', observations: [],
          error: 'Saved LXR report could not be validated. No sample data substituted.' }));
      }
      return;
    }
    if (url.pathname === '/api/research') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const time = now();
        const research = await loadResearch(researchDirectory, time);
        const preview = planAgentCycle(research, emptyAgentState(), { nowMs: time }).report;
        const result = { ...research, agentPreview: { ...preview, previewOnly: true } };
        response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result));
      } catch {
        response.writeHead(503); response.end(request.method === 'HEAD' ? undefined : JSON.stringify({
          available: false, dataset: 'saved-research', freshness: 'unavailable', observations: [],
          sizing: null, analysis: null, agentPreview: null,
          error: 'Saved research could not be validated. No sample data substituted.' }));
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) { response.writeHead(404); response.end('Unknown read-only endpoint'); return; }
    try {
      const branded = url.pathname.startsWith('/brand/');
      const root = await realpath(branded ? brandRoot : webRoot);
      const relative = decodeURIComponent(branded ? url.pathname.slice('/brand/'.length) : url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (branded && !['01-logos', '02-icons', '03-tokens', '04-patterns', '05-imagery', 'fonts'].includes(relative.split('/')[0]) && relative !== '10-handoff/README-AR.md') throw new Error('Not a public brand asset');
      const target = await realpath(path.resolve(root, relative));
      if (!target.startsWith(root + path.sep) || !(await stat(target)).isFile()) throw new Error('Invalid static file');
      // No data directory, environment files, source server modules or directory listing are served.
      response.setHeader('Content-Type', MIME[path.extname(target)] ?? 'application/octet-stream');
      const content = request.method === 'HEAD' ? undefined : await readFile(target);
      response.writeHead(200); response.end(content);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MIR_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MIR_PORT');
  const server = createMirServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'MIR port is already in use.' : 'MIR local server could not start.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`MIR read-only workspace: http://127.0.0.1:${port}/`));
}
