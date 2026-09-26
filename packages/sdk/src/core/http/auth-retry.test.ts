import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticatedFetch } from './auth';
import { configureKortix } from './config';

// `authenticatedFetch` retries a 401 once with a fresh token. The OpenCode
// client hands it a `Request` whose body the FIRST send consumes, so the retry
// has to be built from a copy taken before that send. Bun tolerates reusing a
// used `Request`; the Fetch spec (browsers, Node, Electron) does not, and the
// retry threw `TypeError` there. The Node case below runs the real module under
// `node` so the spec behaviour is what is asserted.

type Seen = { authorization: string | null; body: string };

let seen: Seen[] = [];
let tokenCounter = 0;

beforeEach(() => {
  seen = [];
  tokenCounter = 0;
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => `tok${++tokenCounter}`,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({ authorization: request.headers.get('authorization'), body: await request.text() });
      return new Response('{}', { status: seen.length === 1 ? 401 : 200 });
    },
  });
});

test('a 401 on a body-carrying Request is retried with the same body and the new token', async () => {
  const request = new Request('http://backend.test/v1/p/ext/8000/session/s1/permissions/p1', {
    method: 'POST',
    body: JSON.stringify({ response: 'once' }),
    headers: { 'content-type': 'application/json' },
  });

  const response = await authenticatedFetch(request);

  expect(response.status).toBe(200);
  expect(seen).toEqual([
    { authorization: 'Bearer tok1', body: '{"response":"once"}' },
    { authorization: 'Bearer tok2', body: '{"response":"once"}' },
  ]);
});

test('a 401 on a url + init call is retried with the same body', async () => {
  const response = await authenticatedFetch('http://backend.test/v1/things', {
    method: 'POST',
    body: '{"a":1}',
    headers: { 'content-type': 'application/json' },
  });

  expect(response.status).toBe(200);
  expect(seen.map((s) => s.body)).toEqual(['{"a":1}', '{"a":1}']);
});

test('a 401 on a one-shot stream body is returned, not retried with an empty body', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('chunk'));
      controller.close();
    },
  });

  const response = await authenticatedFetch('http://backend.test/v1/upload', {
    method: 'POST',
    body,
    // Required by the Fetch spec for a stream body.
    ...({ duplex: 'half' } as RequestInit),
  });

  expect(response.status).toBe(401);
  expect(seen).toHaveLength(1);
});

const workDir = mkdtempSync(join(tmpdir(), 'kortix-sdk-retry-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

test('under Node, the 401 retry of a body-carrying Request sends the body again instead of throwing', async () => {
  const entry = join(workDir, 'retry.ts');
  writeFileSync(
    entry,
    `
import { configureKortix } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))};
import { authenticatedFetch } from ${JSON.stringify(join(import.meta.dir, 'auth.ts'))};
let n = 0;
const seen = [];
configureKortix({
  backendUrl: 'http://backend.test/v1',
  getToken: async () => 'tok' + ++n,
  fetch: async (input) => {
    seen.push({ authorization: input.headers.get('authorization'), body: await input.text() });
    return new Response('{}', { status: seen.length === 1 ? 401 : 200 });
  },
});
const request = new Request('http://backend.test/v1/p/ext/8000/session/s1/permissions/p1', {
  method: 'POST',
  body: JSON.stringify({ response: 'once' }),
  headers: { 'content-type': 'application/json' },
});
try {
  const response = await authenticatedFetch(request);
  console.log(JSON.stringify({ status: response.status, seen }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error && error.message), seen }));
}
`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'node', outdir: workDir, naming: 'retry.mjs' });
  expect(built.success).toBe(true);

  const node = Bun.spawnSync(['node', join(workDir, 'retry.mjs')], { stdout: 'pipe', stderr: 'pipe' });
  expect(node.stderr.toString()).toBe('');
  const result = JSON.parse(node.stdout.toString().trim());

  expect(result).toEqual({
    status: 200,
    seen: [
      { authorization: 'Bearer tok1', body: '{"response":"once"}' },
      { authorization: 'Bearer tok2', body: '{"response":"once"}' },
    ],
  });
});
