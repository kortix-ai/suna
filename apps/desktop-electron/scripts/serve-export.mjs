// Serves apps/web/out through the SAME resolver the Electron app:// handler uses.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveSpaFile } = require('../src/spa-resolver.js');
const ROOT = path.resolve(import.meta.dirname, '../../web/out');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.txt':'text/plain', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.ico':'image/x-icon', '.wasm':'application/wasm', '.map':'application/json' };

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolveSpaFile(ROOT, pathname);
  if (!file) { res.writeHead(404, {'content-type':'text/plain'}); return res.end('404 ' + pathname); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(17951, '127.0.0.1', () => console.log('ready'));
