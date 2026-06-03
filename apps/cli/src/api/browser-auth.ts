import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

interface BrowserAuthResult {
  /** The plaintext PAT the dashboard minted on behalf of the user. */
  token: string;
}

interface BrowserAuthSession {
  /** Localhost port the CLI is listening on. */
  port: number;
  /** Opaque nonce — must match in the callback. */
  state: string;
  /** Resolves when the dashboard POSTs the token; rejects on timeout. */
  awaitToken: Promise<BrowserAuthResult>;
  /** Force-close the local server (e.g. on Ctrl+C). */
  close: () => void;
}

interface StartOpts {
  /** Hard ceiling on how long we wait for the user to authorize. */
  timeoutMs?: number;
}

/**
 * Stand up a one-shot HTTP server on a random localhost port that
 * accepts a single signed callback from the Kortix dashboard.
 *
 * The dashboard's authorize page POSTs `{ state, token }` to
 * `http://127.0.0.1:<port>/callback`. CORS is wide-open because we're
 * loopback-only and we want any origin (the dashboard) to be able to
 * deliver. State match is the security check.
 */
export function startCallbackServer(opts: StartOpts = {}): Promise<BrowserAuthSession> {
  const state = randomBytes(32).toString('hex');

  let resolveToken!: (v: BrowserAuthResult) => void;
  let rejectToken!: (err: Error) => void;
  const awaitToken = new Promise<BrowserAuthResult>((res, rej) => {
    resolveToken = res;
    rejectToken = rej;
  });

  const server: Server = createServer((req, res) => {
    // CORS — allow the dashboard origin to POST in.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST' || req.url !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Bound the body size so a malicious origin can't OOM us.
      if (body.length > 16 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      let parsed: { state?: string; token?: string };
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      if (parsed.state !== state) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'state mismatch' }));
        return;
      }
      if (typeof parsed.token !== 'string' || !parsed.token.startsWith('kortix_pat_')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing or malformed token' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      resolveToken({ token: parsed.token });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) {
        reject(new Error('failed to bind callback server'));
        return;
      }

      const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
      const timeout = setTimeout(() => {
        rejectToken(new Error('authorization timed out — closed the browser?'));
        server.close();
      }, timeoutMs);

      const close = () => {
        clearTimeout(timeout);
        server.close();
      };

      // Tear the server down as soon as either side resolves.
      awaitToken.finally(close);

      resolve({ port: addr.port, state, awaitToken, close });
    });
  });
}
