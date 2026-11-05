import { expect, test } from 'bun:test';
import { APP_TEMPLATES } from './app-templates';

const convex = APP_TEMPLATES.convex!;

test('convex: the dashboard is a Dockerfile App in apps/<name>/dashboard, a tab of its backend, signed in by <NAME>_ADMIN_KEY', () => {
  const blocks = convex.blocks('crm-data');
  expect(Object.keys(blocks)).toEqual(['crm-data', 'crm-data-dashboard']);
  expect(blocks['crm-data']!.display).toEqual({ preview: 'none' });
  expect(blocks['crm-data-dashboard']).toMatchObject({
    path: 'apps/crm-data/dashboard',
    type: 'dockerfile',
    command: ['node', '/kortix/start.js'],
    display: { parent: 'crm-data' },
    uses: ['crm-data'],
    http_service: { internal_port: 6791, access: 'admins' },
    secrets: { NEXT_PUBLIC_ADMIN_KEY: 'CRM_DATA_ADMIN_KEY' },
  });
  // No script or shell plumbing in kortix.yaml: it lives in the App's files.
  expect(JSON.stringify(blocks['crm-data-dashboard'])).not.toContain('require(');
  const files = convex.files!('crm-data');
  expect(Object.keys(files)).toEqual(['apps/crm-data/dashboard/Dockerfile', 'apps/crm-data/dashboard/start.js']);
  expect(files['apps/crm-data/dashboard/Dockerfile']).toContain('ENV BACKEND=crm-data');
  expect(files['apps/crm-data/dashboard/Dockerfile']).toMatch(/^FROM ghcr\.io\/convex\/convex-dashboard@sha256:[0-9a-f]{64}$/m);
  expect(convex.secrets!('crm-data')).toEqual([{ name: 'CRM_DATA_ADMIN_KEY', app: 'crm-data', command: ['sh', '-c', 'cd /convex && ./generate_admin_key.sh'] }]);
});

test('convex start.js: starts the dashboard on 6792, answers the embed handshake on /, escapes its values, passes other paths through', () => {
  const start = convex.files!('crm-data')['apps/crm-data/dashboard/start.js']!;
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  let listened: number | undefined;
  const spawned: Array<{ args: string[]; options: { cwd: string; env: Record<string, string> } }> = [];
  const proxied: string[] = [];
  const modules: Record<string, unknown> = {
    child_process: { spawn: (_bin: string, args: string[], options: { cwd: string; env: Record<string, string> }) => { spawned.push({ args, options }); return { on: () => {} }; } },
    http: {
      createServer: (h: typeof handler) => ({ listen: (port: number) => { handler = h; listened = port; } }),
      request: (options: { path: string }) => { proxied.push(options.path); return { on: () => {} }; },
    },
  };
  const env = { KORTIX_APP_URL: 'https://dash.example.test', BACKEND: 'crm-data', NEXT_PUBLIC_ADMIN_KEY: 'key</script><b>' };
  new Function('require', 'process', start)((name: string) => modules[name], { env, exit: () => {} });

  expect(listened).toBe(6791);
  expect(spawned[0]!.args).toEqual(['server.js']);
  expect(spawned[0]!.options.cwd).toBe('/app/dashboard-self-hosted');
  expect(spawned[0]!.options.env).toMatchObject({ PORT: '6792', NEXT_PUBLIC_DEPLOYMENT_URL: 'https://dash.example.test/_kortix/apps/crm-data' });

  let body = '';
  handler!({ method: 'GET', url: '/' }, { writeHead: () => {}, end: (text: string) => { body = text; } });
  expect(body).toContain('<iframe src="/?embedded=1">');
  expect(body).toContain('"deploymentUrl":"https://dash.example.test/_kortix/apps/crm-data"');
  expect(body).not.toContain('</script><b>');
  handler!({ method: 'GET', url: '/?embedded=1', pipe: () => {} }, {});
  expect(proxied).toEqual(['/?embedded=1']);
});

const watcher = APP_TEMPLATES.watcher!;

test('watcher: one on-demand Dockerfile App in apps/<name>, node pinned by digest, the runner and the check', () => {
  expect(Object.keys(watcher.blocks('status-watch'))).toEqual(['status-watch']);
  expect(watcher.blocks('status-watch')['status-watch']).toMatchObject({
    path: 'apps/status-watch',
    type: 'dockerfile',
    command: ['node', 'runner.js'],
    always_on: false,
    http_service: { internal_port: 3000, access: 'app', checks: [{ type: 'http', path: '/health' }] },
  });
  const files = watcher.files!('status-watch');
  expect(Object.keys(files)).toEqual(['apps/status-watch/Dockerfile', 'apps/status-watch/runner.js', 'apps/status-watch/watch.js']);
  expect(files['apps/status-watch/Dockerfile']).toMatch(/^FROM node:22\.[0-9.]+-alpine[0-9.]+@sha256:[0-9a-f]{64}$/m);
  expect(files['apps/status-watch/Dockerfile']).toContain('COPY runner.js watch.js ./');
  expect(watcher.deployOrder('status-watch')).toEqual(['status-watch']);
  expect(watcher.nextSteps('status-watch').join('\n')).toContain('--target-app status-watch --target-path /tick');
});

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>; headers: { get: (name: string) => string | null } };
const answer = (status: number, body: unknown, retryAfter: string | null = null): FakeResponse => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) },
});

/** Run runner.js with a fake http server, fetch and check(); returns a POST /tick caller. */
function loadRunner(check: () => Promise<unknown>, replies: FakeResponse[]) {
  const runner = watcher.files!('w')['apps/w/runner.js']!;
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const posted: Array<{ url: string; auth: string; body: { events: Array<{ name: string; id: string; data: unknown }> } }> = [];
  const modules: Record<string, unknown> = {
    'node:http': { createServer: (h: typeof handler) => ({ listen: (_port: number, ready?: () => void) => { handler = h; ready?.(); } }) },
    'node:crypto': require('node:crypto'),
    './watch.js': { check },
  };
  const fetchFake = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    posted.push({ url, auth: init.headers.authorization!, body: JSON.parse(init.body) });
    return replies.shift() ?? answer(500, { error: 'no reply left' });
  };
  const env = { KORTIX_APP_EVENTS_URL: 'https://kortix.test/v1/projects/p/apps/a/events', KORTIX_APP_TOKEN: 'app-token' };
  new Function('require', 'process', 'fetch', 'console', 'setTimeout', runner)(
    (name: string) => modules[name],
    { env },
    fetchFake,
    { log: () => {}, error: () => {} },
    (fn: () => void) => fn(),
  );
  const call = async (method: string, url: string) => {
    let status = 0;
    let body = '';
    await handler!({ method, url }, { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } });
    return { status, body: JSON.parse(body) as Record<string, unknown> };
  };
  return { call, posted };
}

test('watcher runner: a tick posts what check() returns with ids built from the content, so the same state has the same id', async () => {
  const state = [{ name: 'status.changed', data: { status: 'All Systems Operational' } }];
  const { call, posted } = loadRunner(async () => state, [
    answer(202, { triggers: 1, accepted: 1, deduped: 0, suppressed: 0, unmatched: 0 }),
    answer(202, { triggers: 1, accepted: 0, deduped: 1, suppressed: 0, unmatched: 0 }),
  ]);
  expect(await call('GET', '/health')).toEqual({ status: 200, body: { ok: true } });
  expect((await call('POST', '/tick')).body).toMatchObject({ events: 1, triggers: 1, accepted: 1 });
  expect((await call('POST', '/tick?from=kortix')).body).toMatchObject({ events: 1, accepted: 0, deduped: 1 });
  expect(posted[0]!.auth).toBe('Bearer app-token');
  expect(posted[0]!.body.events[0]).toMatchObject({ name: 'status.changed', data: { status: 'All Systems Operational' } });
  expect(posted[0]!.body.events[0]!.id).toMatch(/^[0-9a-f]{32}$/);
  expect(posted[1]!.body.events[0]!.id).toBe(posted[0]!.body.events[0]!.id);
  expect((await call('GET', '/tick')).status).toBe(404);
});

test('watcher runner: nothing to report sends a heartbeat; 429 is retried; a failing check answers 502', async () => {
  const quiet = loadRunner(async () => [], [answer(429, { error: 'slow down' }, '1'), answer(202, { triggers: 1, accepted: 0, deduped: 0, suppressed: 0, unmatched: 0, heartbeats: 1 })]);
  expect((await quiet.call('POST', '/tick')).body).toMatchObject({ events: 0, triggers: 1 });
  expect(quiet.posted.map((p) => p.body.events as unknown[])).toEqual([[{ name: 'kortix.heartbeat' }], [{ name: 'kortix.heartbeat' }]]);

  const broken = loadRunner(async () => { throw new Error('GET https://status.example.com answered 503'); }, []);
  expect(await broken.call('POST', '/tick')).toEqual({ status: 502, body: { error: 'GET https://status.example.com answered 503' } });

  const refused = loadRunner(async () => [{ name: 'x' }], [answer(400, { error: 'bad name' })]);
  const out = await refused.call('POST', '/tick');
  expect(out.status).toBe(502);
  expect(String(out.body.error)).toContain('Kortix refused the events: 400');
  expect(refused.posted).toHaveLength(1);
});

test('watcher check: back to "All Systems Operational" after an incident is a new event, not a repeat of the first one', async () => {
  const source = watcher.files!('w')['apps/w/watch.js']!;
  const pages = [
    { status: { indicator: 'none', description: 'All Systems Operational' }, page: { updated_at: '2026-11-01T10:00:00.000Z' } },
    { status: { indicator: 'minor', description: 'Minor Service Outage' }, page: { updated_at: '2026-11-02T10:00:00.000Z' } },
    { status: { indicator: 'none', description: 'All Systems Operational' }, page: { updated_at: '2026-11-02T12:00:00.000Z' } },
  ];
  const module = { exports: {} as { check: () => Promise<Array<{ name: string; data: unknown }>> } };
  let page = pages[0];
  new Function('module', 'process', 'fetch', source)(module, { env: {} }, async () => ({ ok: true, status: 200, json: async () => page }));
  const seen: string[] = [];
  for (page of pages) seen.push(JSON.stringify(await module.exports.check()));
  expect(seen[2]).not.toBe(seen[0]);
  // Unchanged page: the same event, so the same content id fires nothing.
  expect(JSON.stringify(await module.exports.check())).toBe(seen[2]);
});
