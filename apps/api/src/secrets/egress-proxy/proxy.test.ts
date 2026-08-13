/**
 * Egress-proxy tests. No mocks: a real HTTPS upstream, a real CONNECT through
 * the real proxy, real TLS termination with a real ephemeral CA.
 *
 * The upstream echoes the headers it received, so "did the credential arrive at
 * the destination" is answered by the destination itself rather than by
 * inspecting our own outgoing object.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

import { createEphemeralCa, LeafIssuer } from './ca';
import { createEgressProxy, type EgressInjectionRule } from './proxy';

const SECRET = 'sk-live-never-in-the-guest';
const POLICY_HOST = 'api.example.test';

/** Upstream TLS needs its own CA; the proxy verifies it via upstreamOptions. */
const upstreamCa = createEphemeralCa('upstream-fixture');
const upstreamLeaf = new LeafIssuer(upstreamCa);

let upstream: https.Server;
let upstreamPort = 0;
let proxy: http.Server;
let proxyPort = 0;
let plainTunnelTarget: net.Server;
let plainTunnelPort = 0;

const proxyCa = createEphemeralCa('sandbox-fixture');

const RULES: EgressInjectionRule[] = [
  { hosts: [POLICY_HOST], header: 'x-proof-token', value: SECRET },
];

beforeAll(async () => {
  // Upstream: echoes what it received, and can be asked to echo the secret back
  // so the redaction path is exercised against a real response body.
  upstream = https.createServer(
    { cert: upstreamLeaf.issue(POLICY_HOST).certPem, key: upstreamLeaf.issue(POLICY_HOST).keyPem },
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/echo-secret') {
        // Deliberately leaks the credential back, to exercise redaction.
        res.end(JSON.stringify({ leaked: req.headers['x-proof-token'] ?? null }));
        return;
      }
      // Reports a DERIVED fact rather than echoing the value. Echoing it would
      // trip the proxy's own redaction and the assertion could never see it —
      // the test would then be measuring redaction while claiming to measure
      // injection.
      const token = req.headers['x-proof-token'];
      res.end(
        JSON.stringify({
          tokenMatched: token === SECRET,
          tokenCount: Array.isArray(token) ? token.length : token === undefined ? 0 : 1,
          sawAttackerValue: JSON.stringify(req.headers).includes('attacker-supplied'),
          url: req.url,
        }),
      );
    },
  );
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  // A plain TCP server standing in for a non-policy destination, so the blind
  // tunnel can be proven to carry bytes the proxy never parses.
  plainTunnelTarget = net.createServer((socket) => {
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  await new Promise<void>((r) => plainTunnelTarget.listen(0, '127.0.0.1', r));
  plainTunnelPort = (plainTunnelTarget.address() as AddressInfo).port;

  proxy = await createEgressProxy({
    ca: proxyCa,
    resolveRules: (token) => (token === 'sandbox-token' ? RULES : null),
    upstreamOptions: () => ({ host: '127.0.0.1', port: upstreamPort, ca: upstreamCa.certPem }),
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => plainTunnelTarget.close(() => r()));
});

/** Open a CONNECT tunnel; resolves with the raw socket on 200. */
function connect(host: string, port: number, token: string | null): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      const auth = token ? `Proxy-Authorization: Bearer ${token}\r\n` : '';
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n\r\n')) return;
      socket.removeListener('data', onData);
      const status = Number(buf.split(' ')[1]);
      if (status === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`CONNECT ${status}: ${buf.split('\r\n')[0]}`));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

/**
 * Speak HTTP/1.1 by hand over the tunnel.
 *
 * Not using `https.request({ socket })`: Bun's HTTP client ignores a
 * pre-opened socket and dials the hostname itself, which made these tests
 * reach for the real internet. Writing the request line directly also means the
 * test asserts against the bytes on the wire rather than a client library's
 * interpretation of them.
 */
function speakHttps(
  socket: net.Socket,
  host: string,
  path: string,
  ca: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, ca }, () => {
      const extra = Object.entries(extraHeaders)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      tlsSocket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${extra}\r\n`);
    });
    const chunks: Buffer[] = [];
    let settled = false;
    /**
     * Complete on content-length rather than on socket close. The proxy sets an
     * accurate length and may legitimately keep the connection alive, so
     * waiting for a FIN would hang on a perfectly good response.
     */
    const tryResolve = () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      if (split === -1) return;
      const head = raw.slice(0, split);
      const body = raw.slice(split + 4);
      const declared = /content-length:\s*(\d+)/i.exec(head);
      if (declared && Buffer.byteLength(body) < Number(declared[1])) return;
      settled = true;
      tlsSocket.destroy();
      resolve({ status: Number(head.split(' ')[1] ?? 0), body });
    };
    tlsSocket.on('data', (c: Buffer) => {
      chunks.push(c);
      tryResolve();
    });
    tlsSocket.on('error', (err: Error) => {
      if (!settled) reject(err);
    });
    tlsSocket.on('close', tryResolve);
  });
}

/** A GET through the tunnel, with the guest trusting the proxy's CA. */
async function getThroughProxy(
  host: string,
  path: string,
  extraHeaders: Record<string, string> = {},
  token: string | null = 'sandbox-token',
) {
  const socket = await connect(host, 443, token);
  return speakHttps(socket, host, path, proxyCa.certPem, extraHeaders);
}

describe('egress proxy', () => {
  test('injects the credential into a policy host, and the guest never sends it', async () => {
    const res = await getThroughProxy(POLICY_HOST, '/whoami');
    expect(res.status).toBe(200);

    const seen = JSON.parse(res.body) as { tokenMatched: boolean; url: string };
    // The destination confirms it received the exact credential — injection
    // happened outside the guest. The client above never sent that header.
    expect(seen.tokenMatched).toBe(true);
    expect(seen.url).toBe('/whoami');
  });

  test('a client-supplied copy of the managed header cannot shadow the real one', async () => {
    // An agent guessing at the header must not be able to override it, or it
    // could probe whether its guess matched.
    const res = await getThroughProxy(POLICY_HOST, '/whoami', {
      'x-proof-token': 'attacker-supplied',
    });
    const seen = JSON.parse(res.body) as {
      tokenMatched: boolean;
      tokenCount: number;
      sawAttackerValue: boolean;
    };
    expect(seen.tokenMatched).toBe(true);
    // Exactly one value on the wire: the client's copy was dropped, not
    // appended alongside ours as a second header value.
    expect(seen.tokenCount).toBe(1);
    expect(seen.sawAttackerValue).toBe(false);
  });

  test('redacts the credential when the upstream echoes it back', async () => {
    const res = await getThroughProxy(POLICY_HOST, '/echo-secret');
    expect(res.status).toBe(200);
    // The upstream really did echo it, so this is the redaction working, not
    // an upstream that happened to omit it.
    expect(res.body).not.toContain(SECRET);
    expect(res.body).toContain('[REDACTED]');
  });

  test('a host with no rule is tunnelled blind, not intercepted', async () => {
    // Target the real upstream by address, which has no injection rule. If the
    // proxy terminated it, the handshake would present OUR leaf and verify
    // against proxyCa; instead it must present the UPSTREAM's own certificate.
    const handshake = (ca: string) =>
      connect('127.0.0.1', upstreamPort, 'sandbox-token').then(
        (socket) =>
          new Promise<boolean>((resolve) => {
            const s = tls.connect({ socket, servername: POLICY_HOST, ca }, () => {
              s.destroy();
              resolve(true);
            });
            s.on('error', () => resolve(false));
          }),
      );

    expect(await handshake(proxyCa.certPem)).toBe(false); // not our cert
    expect(await handshake(upstreamCa.certPem)).toBe(true); // the origin's own
  });

  test('the blind tunnel actually carries bytes', async () => {
    const socket = await connect('127.0.0.1', plainTunnelPort, 'sandbox-token');
    const reply = await new Promise<string>((resolve, reject) => {
      socket.once('data', (d: Buffer) => resolve(d.toString('utf8')));
      socket.once('error', reject);
      socket.write('ping');
    });
    socket.destroy();
    expect(reply).toBe('echo:ping');
  });

  test('rejects a sandbox that does not identify itself', async () => {
    await expect(connect(POLICY_HOST, 443, null)).rejects.toThrow(/407/);
  });

  test('the 407 announces its own close, so a client can retry with credentials', async () => {
    // git sends `Proxy-Connection: Keep-Alive`, takes the challenge, and
    // retries on the SAME socket. Node detaches that socket on `connect`, so
    // nothing parses the retry — without these two headers git reported
    // `Proxy CONNECT aborted` and every clone through the proxy failed
    // (measured, git 2.43.0 in a Daytona guest). Announcing the close is what
    // makes the client open a fresh connection instead.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(
          `CONNECT ${POLICY_HOST}:443 HTTP/1.1\r\nHost: ${POLICY_HOST}:443\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
        );
      });
      let buf = '';
      socket.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
      });
      socket.on('close', () => resolve(buf));
      socket.once('error', reject);
    });

    expect(raw).toContain('407 Proxy Authentication Required');
    expect(raw).toContain('Proxy-Authenticate: Basic');
    expect(raw.toLowerCase()).toContain('content-length: 0');
    expect(raw.toLowerCase()).toContain('connection: close');
  });

  test('rejects an unknown proxy credential', async () => {
    await expect(connect(POLICY_HOST, 443, 'not-a-real-token')).rejects.toThrow(/407/);
  });

  test('refuses plain HTTP so a credential is never put on the wire in clear', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://${POLICY_HOST}/x` },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});

describe('ephemeral CA', () => {
  test('is constrained to signing leaves, and expires', () => {
    const ca = createEphemeralCa('scope-test', 60_000);
    expect(ca.certPem).toContain('BEGIN CERTIFICATE');
    expect(ca.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(ca.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(ca.notAfter.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test('caches leaves per host, so a CONNECT does not pay a keygen', () => {
    const issuer = new LeafIssuer(createEphemeralCa('cache-test'));
    expect(issuer.issue('a.example.test')).toBe(issuer.issue('a.example.test'));
    expect(issuer.issue('b.example.test')).not.toBe(issuer.issue('a.example.test'));
  });

  test('two sandboxes never share a CA', () => {
    expect(createEphemeralCa('s1').fingerprint).not.toBe(createEphemeralCa('s2').fingerprint);
  });
});

/**
 * Shim mode: the proxy runs INSIDE the guest and must never hold a credential.
 * It terminates TLS and relays to the Kortix broker, which injects.
 */
describe('egress proxy — broker (in-guest shim) mode', () => {
  let kortix: http.Server;
  let kortixPort = 0;
  let shim: http.Server;
  let shimPort = 0;
  const brokerCalls: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  let brokerReply: () => { status: number; payload: unknown } = () => ({ status: 200, payload: null });

  const shimCa = createEphemeralCa('shim-fixture');

  beforeAll(async () => {
    // Stands in for the Kortix API's broker route. Plain HTTP on loopback: the
    // relay leg's TLS belongs to the runtime's fetch, not to code under test,
    // and using https here would only be testing whether the fixture's CA is
    // installed. Production points `apiUrl` at the real https API.
    kortix = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        brokerCalls.push({
          path: req.url ?? '',
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        });
        const { status, payload } = brokerReply();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((r) => kortix.listen(0, '127.0.0.1', r));
    kortixPort = (kortix.address() as AddressInfo).port;

    shim = await createEgressProxy({
      ca: shimCa,
      resolveRules: () => [
        {
          mode: 'broker',
          hosts: [POLICY_HOST],
          identifier: 'BROKER_PROOF',
          apiUrl: `http://127.0.0.1:${kortixPort}/v1`,
          token: 'session-token',
          projectId: 'proj-1',
        },
      ],
    });
    await new Promise<void>((r) => shim.listen(0, '127.0.0.1', r));
    shimPort = (shim.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => shim.close(() => r()));
    await new Promise<void>((r) => kortix.close(() => r()));
  });

  function throughShim(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(shimPort, '127.0.0.1', () => {
        socket.write(
          `CONNECT ${POLICY_HOST}:443 HTTP/1.1\r\nHost: ${POLICY_HOST}:443\r\nProxy-Authorization: Bearer t\r\n\r\n`,
        );
      });
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (!buf.includes('\r\n\r\n')) return;
        socket.removeListener('data', onData);
        if (Number(buf.split(' ')[1]) !== 200) {
          socket.destroy();
          reject(new Error(buf.split('\r\n')[0]));
          return;
        }
        speakHttps(socket, POLICY_HOST, path, shimCa.certPem).then(resolve, reject);
      };
      socket.on('data', onData);
      socket.once('error', reject);
    });
  }

  test('relays to the broker route and returns its response', async () => {
    brokerCalls.length = 0;
    brokerReply = () => ({
      status: 200,
      payload: {
        status: 201,
        headers: { 'content-type': 'application/json' },
        body_base64: Buffer.from('{"created":true}').toString('base64'),
      },
    });

    const res = await throughShim('/things?x=1');

    expect(brokerCalls).toHaveLength(1);
    expect(brokerCalls[0].path).toBe('/v1/projects/proj-1/secrets/BROKER_PROOF/broker');
    expect(brokerCalls[0].auth).toBe('Bearer session-token');
    // The shim reconstructs the guest's intended URL for Kortix to perform.
    expect(brokerCalls[0].body.url).toBe(`https://${POLICY_HOST}/things?x=1`);
    expect(brokerCalls[0].body.method).toBe('GET');
    // Upstream status and body are passed through untouched.
    expect(res.status).toBe(201);
    expect(res.body).toBe('{"created":true}');
  });

  test('holds no credential — nothing secret is sent to Kortix or configured locally', async () => {
    brokerCalls.length = 0;
    brokerReply = () => ({
      status: 200,
      payload: { status: 200, headers: {}, body_base64: Buffer.from('ok').toString('base64') },
    });

    await throughShim('/x');

    // The whole request the shim made, serialised: it names an identifier and
    // carries the session's own token, and contains no secret value. This is
    // the property that lets this component run inside an untrusted guest.
    const sent = JSON.stringify(brokerCalls[0]);
    expect(sent).toContain('BROKER_PROOF');
    expect(sent).not.toContain(SECRET);
    // And the rule the shim was configured with has no value field at all.
    expect(JSON.stringify(shim.listeners('connect'))).not.toContain(SECRET);
  });

  test("surfaces the broker's refusal verbatim instead of a generic proxy error", async () => {
    brokerCalls.length = 0;
    brokerReply = () => ({
      status: 403,
      payload: { error: 'secret delivery denied', code: 'agent_grant_excludes' },
    });

    const res = await throughShim('/x');

    // An agent that sees "agent_grant_excludes" can act on it; a bare 502
    // costs it a turn of guessing.
    expect(res.status).toBe(403);
    expect(res.body).toContain('agent_grant_excludes');
  });
});
