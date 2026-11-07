import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

/**
 * Characterization of `kortix sessions message|reachable|inbound` (KRTX-4293):
 * output, exit codes and request bodies that must hold unchanged while the
 * commands move onto the SDK. The real CLI process against a recording stub.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT = 'proj-peer-characterization';
const SELF = '3f2a1b9c-1111-4111-8111-111111111111';
const REVIEWER = '9a8b7c6d-3333-4333-8333-333333333333';

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let route: (req: Seen) => Response | undefined;

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

const agent = (over: Record<string, unknown> = {}) => ({
  handle: 'reviewer',
  session_id: REVIEWER,
  short_id: REVIEWER.slice(0, 8),
  project_id: PROJECT,
  agent_name: 'reviewer',
  title: 'Review the draft',
  relation: 'child',
  state: 'working',
  inbound: 'accept',
  can_receive: true,
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm_7Kq2',
  project_id: PROJECT,
  from_session_id: SELF,
  from_handle: 'main',
  to_session_id: REVIEWER,
  to_handle: 'reviewer',
  type: 'message',
  message: 'The schema change landed.',
  summary: null,
  status: 'held',
  notify_when_idle: false,
  created_at: '2026-10-30T10:00:00.000Z',
  decided_at: null,
  ...over,
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
      const entry: Seen = { method: req.method, path: url.pathname.replace(/^\/v1/, '') + url.search, body: text ? JSON.parse(text) : null };
      seen.push(entry);
      return route(entry) ?? json({ error: true, message: `stub: no route for ${entry.method} ${entry.path}` }, 404);
    },
  });
});

afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  route = () => undefined;
});

async function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = {
    ...(process.env as Record<string, string>),
    KORTIX_TOKEN: 'session-agent-token',
    KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
    KORTIX_PROJECT_ID: PROJECT,
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    KORTIX_SESSION_ID: undefined,
    KORTIX_FEATURE_FLAGS: undefined,
    KORTIX_ERROR_FORMAT: undefined,
    ...env,
  };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: CLI_ROOT,
    env: merged as Record<string, string>,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

const IN_BOX = { KORTIX_SESSION_ID: SELF };
const REACHABLE = { self: agent({ handle: 'main', session_id: SELF, short_id: SELF.slice(0, 8), relation: 'self' }), agents: [agent()] };

describe('sessions reachable without --scope', () => {
  test('lists the caller\'s own agents and hints at --scope project', async () => {
    route = (r) => (r.path.includes('/reachable') ? json(REACHABLE) : undefined);
    const result = await runCli(['sessions', 'reachable'], IN_BOX);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('You are main (3f2a1b9c)');
    expect(result.stdout).toMatch(/HANDLE\s+ID\s+RELATION\s+STATE\s+INBOUND/);
    expect(result.stdout).toMatch(/reviewer\s+9a8b7c6d\s+child\s+working\s+accept/);
    // The server's default scope is `mine`: the CLI no longer sends it.
    expect(seen.map((s) => s.path)).toEqual([`/workspaces/${PROJECT}/sessions/${SELF}/reachable`]);
  });

  test('with no other session it says so and names --scope workspace; --json prints { self, agents }', async () => {
    route = (r) => (r.path.includes('/reachable') ? json({ ...REACHABLE, agents: [] }) : undefined);
    const human = await runCli(['sessions', 'reachable'], IN_BOX);
    expect(human.stdout).toContain('No other session to reach. Pass --scope workspace for every live session of the workspace.');
    const machine = await runCli(['sessions', 'reachable', '--json'], IN_BOX);
    expect(JSON.parse(machine.stdout)).toEqual({ ...REACHABLE, agents: [] });
  });

  test('an API failure exits 1 with the server message', async () => {
    route = () => json({ error: true, message: 'Session not found.' }, 404);
    const result = await runCli(['sessions', 'reachable'], IN_BOX);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Session not found.');
  });

  test('a rejected token and a server fault are worded from the status, as on every CLI request', async () => {
    route = () => json({ error: true, message: 'Boom.' }, 401);
    const rejected = await runCli(['sessions', 'reachable'], IN_BOX);
    expect(rejected.stderr).toContain('Token rejected — Boom.. Run `kortix login` to re-authenticate.');
    route = () => json({ error: true, message: 'Boom.' }, 500);
    const fault = await runCli(['sessions', 'message', 'reviewer', 'hello'], IN_BOX);
    expect(fault.stderr).toContain('HTTP 500: Boom.');
  });
});

describe('sessions message', () => {
  test('--shutdown and --to-project ride in the body', async () => {
    route = (r) => (r.method === 'POST' ? json({ status: 'delivered', message: message({ status: 'delivered' }), to: agent(), note: '' }) : undefined);
    const result = await runCli(['sessions', 'message', 'reviewer', 'wrap up', '--shutdown', '--to-project', 'proj-other'], IN_BOX);
    expect(result.code).toBe(0);
    expect(seen.map((s) => s.body)).toEqual([{ to: 'reviewer', message: 'wrap up', type: 'shutdown_request', project_id: 'proj-other' }]);
  });

  test('a dropped duplicate exits 0 with the server note', async () => {
    route = () => json({ status: 'dropped', message: null, to: agent(), note: 'Dropped: same text.' });
    const result = await runCli(['sessions', 'message', 'reviewer', 'hello'], IN_BOX);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dropped: same text.');
  });

  test('a server error exits 1 with its message', async () => {
    route = () => json({ error: true, message: 'Rate limit: 30 messages per minute.' }, 429);
    const result = await runCli(['sessions', 'message', 'reviewer', 'hello'], IN_BOX);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Rate limit: 30 messages per minute.');
  });

  test('409 ambiguous_recipient with --json prints the candidates as JSON', async () => {
    route = () => json({ error: true, code: 'ambiguous_recipient', message: '"writer" names 2 sessions.', candidates: [agent({ handle: 'writer', short_id: 'aaaa1111' })] }, 409);
    const result = await runCli(['sessions', 'message', 'writer', 'hello', '--json'], IN_BOX);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: true, code: 'ambiguous_recipient', candidates: [{ short_id: 'aaaa1111' }] });
  });
});

describe('sessions inbound', () => {
  const session = (over: Record<string, unknown>) => ({ session_id: REVIEWER, ...over });

  test('the current mode comes from the session row, else its metadata, else accept', async () => {
    const mode = async (row: Record<string, unknown>) => {
      route = (r) => (r.method === 'GET' ? json(session(row)) : undefined);
      return JSON.parse((await runCli(['sessions', 'inbound', REVIEWER, '--json'])).stdout).inbound;
    };
    expect(await mode({ inbound: 'refuse', metadata: { inbound: 'hold' } })).toBe('refuse');
    expect(await mode({ metadata: { inbound: 'hold' } })).toBe('hold');
    expect(await mode({ metadata: { inbound: 'bogus' } })).toBe('accept');
    expect(await mode({})).toBe('accept');
    route = (r) => (r.method === 'GET' ? json(session({ inbound: 'hold' })) : undefined);
    expect((await runCli(['sessions', 'inbound', REVIEWER])).stdout).toContain('9a8b7c6d takes messages: hold');
  });

  test('ls with no messages says so; --json prints { messages }', async () => {
    route = () => json({ messages: [] });
    const human = await runCli(['sessions', 'inbound', REVIEWER, 'ls']);
    expect(human.stdout).toContain('No messages to 9a8b7c6d.');
    const machine = await runCli(['sessions', 'inbound', REVIEWER, 'ls', '--json']);
    expect(JSON.parse(machine.stdout)).toEqual({ messages: [] });
  });

  test('ls previews the summary, else the first 80 characters of the text on one line', async () => {
    route = () => json({ messages: [message({ summary: null, message: `first\n\nsecond ${'x'.repeat(100)}` })] });
    const result = await runCli(['sessions', 'inbound', REVIEWER, 'ls']);
    expect(result.stdout).toContain(`first second ${'x'.repeat(67)}\n`);
  });

  test('deny posts to the deny route and says the message was declined; --json prints the message', async () => {
    route = (r) => (r.method === 'POST' ? json(message({ status: 'denied' })) : undefined);
    const human = await runCli(['sessions', 'inbound', REVIEWER, 'deny', 'm_7Kq2']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Declined the message from main');
    const machine = await runCli(['sessions', 'inbound', REVIEWER, 'deny', 'm_7Kq2', '--json']);
    expect(JSON.parse(machine.stdout)).toMatchObject({ id: 'm_7Kq2', status: 'denied' });
    expect(seen.map((s) => [s.method, s.path])).toEqual([
      ['POST', `/workspaces/${PROJECT}/sessions/${REVIEWER}/peer-messages/m_7Kq2/deny`],
      ['POST', `/workspaces/${PROJECT}/sessions/${REVIEWER}/peer-messages/m_7Kq2/deny`],
    ]);
  });

  test('a message id is percent-encoded into the route', async () => {
    route = (r) => (r.method === 'POST' ? json(message()) : undefined);
    await runCli(['sessions', 'inbound', REVIEWER, 'approve', 'm 1']);
    expect(seen[0]?.path).toBe(`/workspaces/${PROJECT}/sessions/${REVIEWER}/peer-messages/m%201/approve`);
  });

  test('approve without an id is a usage error before any request', async () => {
    const result = await runCli(['sessions', 'inbound', REVIEWER, 'approve']);
    expect(result.code).toBe(2);
    expect(seen).toEqual([]);
  });

  test('every mode names what it does', async () => {
    route = (r) => (r.method === 'PUT' ? json({ inbound: (r.body as { inbound: string }).inbound }) : undefined);
    expect((await runCli(['sessions', 'inbound', REVIEWER, 'refuse'])).stdout).toContain('9a8b7c6d now refuses messages from other sessions.');
    expect((await runCli(['sessions', 'inbound', REVIEWER, 'accept'])).stdout).toContain('9a8b7c6d now accepts messages from other sessions.');
  });

  test('an API failure on a held-message action exits 1 with the server message', async () => {
    route = () => json({ error: true, message: 'Message already decided.' }, 409);
    const result = await runCli(['sessions', 'inbound', REVIEWER, 'approve', 'm_7Kq2']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Message already decided.');
  });
});
