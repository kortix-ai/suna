// Serves the Convex dashboard (a static export, version-matched to this
// backend) on port 6791. Kortix web frames it and hands it the admin key over
// Convex's own postMessage handshake; KORTIX_FRAME_ANCESTORS limits who may
// frame it. Copied into the backend image by convex-image.ts.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = '/opt/convex-dashboard';
const PORT = Number(process.env.DASHBOARD_PORT || 6791);
const ANCESTORS = (process.env.KORTIX_FRAME_ANCESTORS || '').trim() || "'none'";
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const base = join(ROOT, normalize(decoded));
  if (base !== ROOT && !base.startsWith(`${ROOT}/`)) return null;
  // Next's static export: /data → data.html, / → index.html, /settings → settings.html.
  for (const candidate of [base, `${base}.html`, join(base, 'index.html')]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return null;
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url || '/', 'http://local');
    const file = (await resolveFile(pathname)) ?? join(ROOT, '404.html');
    const body = await readFile(file);
    res.writeHead(file.endsWith('/404.html') && pathname !== '/404' ? 404 : 200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'content-security-policy': `frame-ancestors ${ANCESTORS}`,
      'cache-control': pathname.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
  }
}).listen(PORT, '0.0.0.0');
