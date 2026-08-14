// Serves the bundled Kortix web app from a loopback HTTP server.
//
// The shell has always loaded a remote URL (kortix.com). In bundle mode it
// instead serves a static export of apps/web's (app) route group, built by
// apps/web/desktop/build.mjs, from inside the installer: no page load waits on
// the network, and the frontend cannot drift mid-session because a deploy
// landed.
//
// WHY LOOPBACK HTTP AND NOT A CUSTOM app:// SCHEME
// A custom scheme can be registered as standard+secure, but it remains an
// origin nothing else in the stack has ever seen. Supabase keys its stored
// session by origin, the kortix:// OAuth bounce redirects back to an http URL,
// and service workers and third-party embeds (the Pipedream Connect iframe that
// caused the Tauri→Electron migration in the first place) all assume http(s).
// 127.0.0.1 is an ordinary secure origin, so every one of those behaves exactly
// as it does on the web and there is nothing new to verify.
//
// Two jobs:
//   1. FILES — resolve a URL path to a file in the export. Dynamic routes are
//      exported once against a `__shell__` placeholder, so spa-resolver.js
//      rewrites segment-by-segment; apps/web/desktop/nav-shim.tsx then recovers
//      the real param from the URL at render time.
//   2. API — proxy /v1 (and friends) to the real backend. On the web those are
//      same-origin rewrites in next.config.ts, which a static export does not
//      have. Proxying keeps every request same-origin from the renderer's point
//      of view: no CORS preflight, no cookie SameSite surprises, and no change
//      to how apps/web builds request URLs.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { resolveSpaFile } = require('./spa-resolver');

// Paths the renderer expects same-origin but which the API actually serves.
// Mirrors the rewrites in apps/web/next.config.ts.
const PROXY_PREFIXES = ['/v1/', '/scim/', '/supabase/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Directory holding the static export, or null when this build has no bundle.
 *
 * Dev runs point at apps/web/out via KORTIX_DESKTOP_BUNDLE_DIR; a packaged app
 * ships it under resources/web (electron-builder extraResources).
 */
function bundleDir() {
  const override = process.env.KORTIX_DESKTOP_BUNDLE_DIR;
  if (override) return fs.existsSync(override) ? override : null;

  const packaged = path.join(process.resourcesPath || '', 'web');
  return fs.existsSync(packaged) ? packaged : null;
}

function isBundleMode() {
  return bundleDir() !== null;
}

/** Forward one API request to the backend and pipe the response straight back. */
async function proxyToBackend(req, res, backendOrigin) {
  const target = new URL(req.url, backendOrigin);

  const headers = { ...req.headers };
  // The renderer's Origin/Referer are the loopback server, which no backend
  // CORS policy knows about. Strip them: this is a local proxy, not a
  // cross-site browser request.
  delete headers.origin;
  delete headers.referer;
  delete headers.host;
  delete headers['accept-encoding']; // let undici handle content negotiation

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  const upstream = await fetch(target.toString(), {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
    redirect: 'manual',
  });

  // `upstream.body` is ALREADY decoded — undici transparently inflates br/gzip.
  // Forwarding the upstream content-encoding therefore tells the renderer to
  // decompress plain bytes, which fails as `ERR__ERROR_FORMAT_PADDING_2`
  // (observed against /v1/health, which dev serves as brotli). content-length
  // goes for the same reason: the decoded length differs from the encoded one.
  const DROP_HEADERS = [
    'transfer-encoding',
    'connection',
    'keep-alive',
    'content-encoding',
    'content-length',
  ];

  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (DROP_HEADERS.includes(key)) return;
    outHeaders[key] = value;
  });

  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) return res.end();

  // Stream rather than buffer: SSE is how session events reach the UI, and
  // buffering would stall the transcript until the run finished.
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

/**
 * Start the loopback server for the bundled app.
 *
 * @param {string} backendOrigin Origin of the Kortix API, e.g. https://dev-api.kortix.com
 * @param {string} [webOrigin] Origin of the real website, for paths the bundle does not carry
 * @returns {Promise<{ baseUrl: string, port: number, close: () => void }>}
 */
function startBundleServer(backendOrigin, webOrigin) {
  const root = bundleDir();
  if (!root) throw new Error('startBundleServer() called with no bundle present');

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);

    if (PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      proxyToBackend(req, res, backendOrigin).catch((err) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Upstream request failed: ${err.message}`);
      });
      return;
    }

    const file = resolveSpaFile(root, pathname);
    if (!file) {
      // The bundle carries the product surface only. Marketing, legal, and docs
      // pages still exist — on the real website — and the auth page links
      // straight at them (/legal/terms, /legal?tab=privacy). Redirect instead of
      // 404ing: the shell's navigation gate then sees a non-product URL on the
      // web host and opens it in the user's real browser, which is where a
      // Terms page belongs anyway.
      if (webOrigin) {
        res.writeHead(302, { location: new URL(req.url, webOrigin).toString() });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Not found in bundle: ${pathname}`);
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      // Hashed assets under /_next/static are immutable; HTML is not.
      'cache-control': pathname.startsWith('/_next/static/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });

  // THE PORT MUST BE STABLE ACROSS LAUNCHES.
  //
  // Origin is http://127.0.0.1:<port>, and the Supabase session lives in that
  // origin's localStorage. An OS-assigned port (listen(0)) therefore produces a
  // brand-new origin every launch, which silently discards the session — the
  // user is signed out every single time they reopen the app, and the PKCE
  // verifier written when a sign-in starts is unreadable by the time the
  // callback arrives. So: a fixed port, and a small deterministic ladder of
  // fallbacks for the rare case something else already holds it.
  const candidates = [
    Number(process.env.KORTIX_DESKTOP_BUNDLE_PORT) || 0,
    43110,
    43111,
    43112,
    43113,
    43114,
  ].filter(Boolean);

  const listenOn = (port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.once('error', onError);
      // Loopback only: nothing on the network can reach the bundle or the proxy.
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          port,
          close: () => server.close(),
        });
      });
    });

  return (async () => {
    let lastError;
    for (const port of candidates) {
      try {
        return await listenOn(port);
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
        lastError = err;
      }
    }
    throw new Error(
      `No free bundle port among ${candidates.join(', ')}. ` +
        `Set KORTIX_DESKTOP_BUNDLE_PORT to one that is free. (${lastError?.message})`,
    );
  })();
}

module.exports = { startBundleServer, isBundleMode, bundleDir };
