import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve, join } from 'node:path';

/**
 * Messages between sessions (`kortix sessions message|reachable|inbound`), the
 * agent team task list (`kortix tasks`, flag `agent_teams`) and the agent
 * board fields of `kortix sessions status --json`.
 *
 * Driven black-box: the real CLI process against a recording stub API that
 * answers with the `@kortix/api-contract/multi-agent` shapes.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT = 'proj-multi-agent';
const SELF = '3f2a1b9c-1111-4111-8111-111111111111';
const LEAD = '7c0d2e4f-2222-4222-8222-222222222222';
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
  status: 'delivered',
  notify_when_idle: false,
  created_at: '2026-10-30T10:00:00.000Z',
  decided_at: null,
  ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  lead_session_id: LEAD,
  subject: 'Draft the outline',
  description: '',
  status: 'pending',
  owner_handle: null,
  owner_session_id: null,
  blocked_by: [],
  blocked: false,
  created_by_session_id: LEAD,
  created_at: '2026-10-30T10:00:00.000Z',
  updated_at: '2026-10-30T10:00:00.000Z',
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

async function runCli(args: string[], env: Record<string, string | undefined> = {}, stdin?: string) {
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
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

const IN_BOX = { KORTIX_SESSION_ID: SELF };
const sends = () => seen.filter((s) => s.method === 'POST' && s.path.endsWith('/peer-messages'));

describe('kortix sessions message', () => {
  test('inside a session it sends as $KORTIX_SESSION_ID with the summary and the idle notice', async () => {
    route = (r) => (r.method === 'POST' ? json({ status: 'delivered', message: message({ notify_when_idle: true }), to: agent(), note: 'Delivered to reviewer.' }) : undefined);
    const result = await runCli(['sessions', 'message', 'reviewer', 'The schema change landed.', '--summary', 'Schema landed', '--notify-idle'], IN_BOX);
    expect(result.code).toBe(0);
    expect(sends()).toEqual([
      {
        method: 'POST',
        path: `/projects/${PROJECT}/sessions/${SELF}/peer-messages`,
        body: { to: 'reviewer', message: 'The schema change landed.', summary: 'Schema landed', notify_when_idle: true },
      },
    ]);
    expect(result.stdout).toContain('Delivered to reviewer (9a8b7c6d)');
    expect(result.stdout).toContain('One notice comes back when its turn ends.');
  });

  test('outside a session it needs --from, and refuses before any request without it', async () => {
    const result = await runCli(['sessions', 'message', 'reviewer', 'hello']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Pass --from <session>');
    expect(seen).toEqual([]);

    route = (r) => (r.method === 'POST' ? json({ status: 'delivered', message: message(), to: agent(), note: '' }) : undefined);
    const sent = await runCli(['sessions', 'message', 'reviewer', 'hello', '--from', LEAD]);
    expect(sent.code).toBe(0);
    expect(sends()[0]?.path).toBe(`/projects/${PROJECT}/sessions/${LEAD}/peer-messages`);
  });

  test('the text comes from stdin when none is given', async () => {
    route = (r) => (r.method === 'POST' ? json({ status: 'delivered', message: message(), to: agent(), note: '' }) : undefined);
    const result = await runCli(['sessions', 'message', 'parent'], IN_BOX, 'Test run: 2 failures\n');
    expect(result.code).toBe(0);
    expect(sends()[0]?.body).toEqual({ to: 'parent', message: 'Test run: 2 failures' });
  });

  test('a message over 16,000 characters is refused before it leaves', async () => {
    const result = await runCli(['sessions', 'message', 'reviewer', 'x'.repeat(16_001)], IN_BOX);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('the limit is 16,000');
    expect(seen).toEqual([]);
  });

  test('a refused message exits 1 with the server note; --json still prints the result', async () => {
    route = () => json({ status: 'refused', message: null, to: agent({ inbound: 'refuse', can_receive: false }), note: 'Not sent: reviewer refuses messages.' });
    const human = await runCli(['sessions', 'message', 'reviewer', 'hello'], IN_BOX);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('Not sent: reviewer refuses messages.');

    const machine = await runCli(['sessions', 'message', 'reviewer', 'hello', '--json'], { ...IN_BOX, KORTIX_ERROR_FORMAT: 'json' });
    expect(machine.code).toBe(1);
    expect(JSON.parse(machine.stdout).status).toBe('refused');
    const line = machine.stderr.split('\n').find((l) => l.startsWith('{"kortix_error"'));
    expect(JSON.parse(line!).kortix_error).toMatchObject({ kind: 'failed', code: 'peer_message_refused' });
  });

  test('a held message exits 0 and says it waits for a person', async () => {
    route = () => json({ status: 'held', message: message({ status: 'held' }), to: agent({ inbound: 'hold' }), note: 'Held for approval.' });
    const result = await runCli(['sessions', 'message', 'reviewer', 'hello'], IN_BOX);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Held for reviewer's person to approve (expires in 5 min).");
  });

  test('409 ambiguous_recipient lists the candidates to pick from', async () => {
    route = () =>
      json(
        {
          error: true,
          code: 'ambiguous_recipient',
          message: '"writer" names 2 sessions.',
          candidates: [agent({ handle: 'writer', short_id: 'aaaa1111' }), agent({ handle: 'writer', short_id: 'bbbb2222' })],
        },
        409,
      );
    const result = await runCli(['sessions', 'message', 'writer', 'hello'], IN_BOX);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"writer" names 2 sessions');
    expect(result.stderr).toContain('aaaa1111');
    expect(result.stderr).toContain('bbbb2222');
  });
});

describe('kortix sessions reachable', () => {
  test('lists the reachable sessions of this session, scope project on request', async () => {
    route = (r) =>
      r.path.includes('/reachable')
        ? json({ self: agent({ handle: 'main', session_id: SELF, short_id: SELF.slice(0, 8), relation: 'self' }), agents: [agent(), agent({ handle: 'ops', relation: 'session', inbound: 'refuse', can_receive: false, short_id: 'cccc3333' })] })
        : undefined;
    const result = await runCli(['sessions', 'reachable', '--scope', 'project'], IN_BOX);
    expect(result.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual([`/projects/${PROJECT}/sessions/${SELF}/reachable?scope=project`]);
    expect(result.stdout).toContain('You are main (3f2a1b9c)');
    expect(result.stdout).toMatch(/reviewer\s+9a8b7c6d\s+child\s+working\s+accept/);
    expect(result.stdout).toMatch(/ops\s+cccc3333\s+session\s+working\s+can't receive/);

    const bad = await runCli(['sessions', 'reachable', '--scope', 'everyone'], IN_BOX);
    expect(bad.code).toBe(2);
  });
});

describe('kortix sessions inbound', () => {
  test('sets the mode, lists and approves held messages', async () => {
    route = (r) => {
      if (r.method === 'PUT' && r.path.endsWith('/inbound')) return json({ inbound: (r.body as { inbound: string }).inbound });
      if (r.method === 'GET' && r.path.includes('/peer-messages?direction=in')) return json({ messages: [message({ status: 'held', summary: 'Can I drop the old table?' })] });
      if (r.method === 'POST' && r.path.endsWith('/approve')) return json(message({ status: 'delivered' }));
      if (r.method === 'GET') return json({ session_id: REVIEWER, inbound: 'hold', metadata: {} });
      return undefined;
    };
    const set = await runCli(['sessions', 'inbound', REVIEWER, 'hold']);
    expect(set.code).toBe(0);
    expect(seen.at(-1)).toEqual({ method: 'PUT', path: `/projects/${PROJECT}/sessions/${REVIEWER}/inbound`, body: { inbound: 'hold' } });
    expect(set.stdout).toContain('holds each message for a person to approve');

    const current = await runCli(['sessions', 'inbound', REVIEWER, '--json']);
    expect(JSON.parse(current.stdout)).toEqual({ session_id: REVIEWER, inbound: 'hold' });

    const ls = await runCli(['sessions', 'inbound', REVIEWER, 'ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/m_7Kq2\s+held\s+from main\s+Can I drop the old table\?/);

    const approve = await runCli(['sessions', 'inbound', REVIEWER, 'approve', 'm_7Kq2']);
    expect(approve.code).toBe(0);
    expect(seen.at(-1)?.path).toBe(`/projects/${PROJECT}/sessions/${REVIEWER}/peer-messages/m_7Kq2/approve`);
    expect(approve.stdout).toContain('Delivered the message from main');

    const bad = await runCli(['sessions', 'inbound', REVIEWER, 'maybe']);
    expect(bad.code).toBe(2);
  });
});

describe('kortix tasks (flag agent_teams)', () => {
  const TEAM = { KORTIX_FEATURE_FLAGS: 'agent_teams' };

  test('with the flag off the command does not run', async () => {
    const result = await runCli(['tasks', 'ls'], { ...IN_BOX, KORTIX_FEATURE_FLAGS: 'goals' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('behind the `agent_teams` feature flag');
    expect(seen).toEqual([]);
  });

  test("inside a teammate the list is its lead's: add sends subject, owner and blocked_by", async () => {
    route = (r) => {
      if (r.method === 'GET' && r.path === `/projects/${PROJECT}/sessions/${SELF}`) return json({ session_id: SELF, team_lead_session_id: LEAD, metadata: { team_lead: LEAD } });
      if (r.method === 'POST' && r.path.endsWith('/tasks')) return json(task({ seq: 3, subject: 'Review the draft', owner_handle: 'reviewer', blocked_by: [1, 2], blocked: true }), 201);
      return undefined;
    };
    const result = await runCli(['tasks', 'add', 'Review the draft', '--owner', 'reviewer', '--blocked-by', '1,#2'], { ...IN_BOX, ...TEAM });
    expect(result.code).toBe(0);
    expect(seen.at(-1)).toEqual({
      method: 'POST',
      path: `/projects/${PROJECT}/sessions/${LEAD}/tasks`,
      body: { subject: 'Review the draft', owner: 'reviewer', blocked_by: [1, 2] },
    });
    expect(result.stdout).toContain('Added #3 Review the draft @reviewer');
  });

  test('ls prints state, owner and what a blocked task waits for', async () => {
    route = (r) =>
      r.path.endsWith('/tasks')
        ? json({ tasks: [task(), task({ seq: 2, subject: 'Write it', status: 'in_progress', owner_handle: 'writer' }), task({ seq: 3, subject: 'Review it', blocked_by: [2], blocked: true })] })
        : undefined;
    const result = await runCli(['tasks', LEAD, 'ls'], TEAM);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('3 tasks · 3 open');
    expect(result.stdout).toMatch(/#2\s+working\s+@writer\s+Write it/);
    expect(result.stdout).toMatch(/#3\s+blocked\s+—\s+Review it\s+waits for #2/);
  });

  test('claim sends claim: true; a lost race exits 3 with the server reason', async () => {
    route = (r) => (r.method === 'PATCH' ? json({ error: true, code: 'task_taken', message: 'Task #2 was claimed by writer.' }, 409) : undefined);
    const result = await runCli(['tasks', LEAD, 'claim', '2'], TEAM);
    expect(result.code).toBe(3);
    expect(seen.at(-1)).toEqual({ method: 'PATCH', path: `/projects/${PROJECT}/sessions/${LEAD}/tasks/2`, body: { claim: true } });
    expect(result.stderr).toContain('Task #2 was claimed by writer.');
  });

  test('done, update --release and rm send the contract bodies', async () => {
    route = (r) => (r.method === 'DELETE' ? json({ deleted: true }) : r.method === 'PATCH' ? json(task({ status: 'completed' })) : undefined);
    expect((await runCli(['tasks', LEAD, 'done', '1'], TEAM)).code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ status: 'completed' });
    expect((await runCli(['tasks', LEAD, 'update', '1', '--release', '--status', 'pending', '--blocked-by', '4'], TEAM)).code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ status: 'pending', owner: null, add_blocked_by: [4] });
    expect((await runCli(['tasks', LEAD, 'rm', '1'], TEAM)).code).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/projects/${PROJECT}/sessions/${LEAD}/tasks/1` });
  });

  test('outside a session the lead is required; a bad task number is a usage error', async () => {
    const noLead = await runCli(['tasks', 'ls'], TEAM);
    expect(noLead.code).toBe(2);
    expect(noLead.stderr).toContain('Pass the lead session');
    const bad = await runCli(['tasks', LEAD, 'claim', 'two'], TEAM);
    expect(bad.code).toBe(2);
    expect(seen).toEqual([]);
  });
});

describe('kortix sessions status --json', () => {
  test('each row carries the agent board fields, null on an older API', async () => {
    const row = (id: string, extra: Record<string, unknown>) => ({
      session_id: id,
      name: null,
      status: 'running',
      working: { state: 'idle' },
      branch_name: 'b',
      agent_name: 'worker',
      model: null,
      metadata: {},
      updated_at: '2026-10-30T10:00:00.000Z',
      created_at: '2026-10-30T10:00:00.000Z',
      ...extra,
    });
    route = (r) =>
      r.path === `/projects/${PROJECT}/sessions`
        ? json([row(REVIEWER, { board_state: 'needs_input', attention: 'question', agent_handle: 'reviewer', team_lead_session_id: LEAD }), row(SELF, {})])
        : undefined;
    const result = await runCli(['sessions', 'status', '--json']);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(rows.find((r) => r.session_id === REVIEWER)).toMatchObject({ board_state: 'needs_input', attention: 'question', agent_handle: 'reviewer', team_lead_session_id: LEAD });
    expect(rows.find((r) => r.session_id === SELF)).toMatchObject({ board_state: null, attention: null, agent_handle: null, team_lead_session_id: null });

    const human = await runCli(['sessions', 'status']);
    expect(human.stdout).toMatch(/@reviewer\s+needs you: question/);
  });
});
