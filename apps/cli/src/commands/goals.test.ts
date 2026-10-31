import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatGoalFile, parseGoalFile, type ProjectGoalDocument } from '@kortix/sdk';
import {
  goalViolations,
  missingGoalFlags,
  recordWake,
  slugify,
  takeEnforcementSlot,
  transitionViolations,
  verdictViolations,
  verifyViolations,
} from './goals';

const base: ProjectGoalDocument = {
  version: 1,
  objective: 'EU billing live',
  status: 'active',
  summary: '',
  assigned_user: 'u1',
  agent: 'billing',
  success_criteria: [
    { id: 'c1', text: 'EUR invoice with VAT', met: true, evidence: 'evidence/a.md' },
    { id: 'c2', text: 'Checkout charges EUR', met: true, evidence: 'evidence/b.md' },
  ],
  items: [],
  links: [],
  waiting_on: null,
  heartbeat_every: '4h',
  max_wakes_per_day: 3,
  max_sessions: 3,
  sessions: [{ id: 'owner', role: 'owner', since: '2026-10-28T08:00:00Z' }],
  reminder_id: 'reminder.aaaaaaaaaaaa',
  next_wake_at: null,
  verified_by: null,
  transitions: [
    { from: null, to: 'draft', at: '2026-10-28T08:00:00Z', reason: 'goal created', by: 'owner' },
    { from: 'draft', to: 'active', at: '2026-10-28T08:01:00Z', reason: 'criteria written', by: 'owner' },
  ],
  body: '',
};
const verifying: ProjectGoalDocument = {
  ...base,
  status: 'verifying',
  sessions: [...base.sessions, { id: 'ver', role: 'verifier', since: '2026-10-28T09:00:00Z' }],
  transitions: [...base.transitions, { from: 'active', to: 'verifying', at: '2026-10-28T09:00:00Z', reason: 'claims done', by: 'owner' }],
};
const facts = { activeHeartbeats: ['reminder.aaaaaaaaaaaa'], unattended: true, sessionId: 'owner' };

describe('the goal lifecycle', () => {
  test('draft → active needs 1 to 8 done criteria, one heartbeat and an unattended owner', () => {
    const draft = { ...base, status: 'draft' as const, success_criteria: [] };
    expect(transitionViolations(draft, 'active', 'planned', { ...facts, unattended: false }).length).toBe(2);
    expect(transitionViolations({ ...draft, success_criteria: base.success_criteria }, 'active', 'planned', facts)).toEqual([]);
  });

  test('only the owner session moves a goal; every move needs a reason', () => {
    expect(transitionViolations(base, 'waiting_on_user', 'Which VAT id?', { ...facts, sessionId: 'someone' })[0]).toContain('owner');
    expect(transitionViolations(base, 'waiting_on_user', ' ', facts)[0]).toContain('--reason');
    expect(transitionViolations(base, 'waiting_on_user', 'Which VAT id?', facts)).toEqual([]);
    expect(transitionViolations({ ...base, status: 'waiting_on_user' }, 'active', 'answered', facts)).toEqual([]);
  });

  test('nobody transitions to verifying or done: verify and the verifier verdict do that', () => {
    expect(transitionViolations(base, 'verifying', 'all met', facts)[0]).toContain('kortix goals verify');
    expect(transitionViolations(verifying, 'done', 'looks good', facts)[0]).toContain('kortix goals verdict');
  });

  test('any open state → stopped; a closed goal has no moves', () => {
    for (const status of ['draft', 'active', 'waiting_on_user', 'verifying'] as const) {
      expect(transitionViolations({ ...base, status }, 'stopped', 'the user said stop', facts)).toEqual([]);
    }
    expect(transitionViolations({ ...base, status: 'done' }, 'active', 'again', facts)[0]).toContain('closed');
  });

  test('verify needs every criterion met with an existing evidence file, and room for one more session', () => {
    const evidence = new Set(['evidence/a.md', 'evidence/b.md']);
    expect(verifyViolations(base, { existingEvidence: evidence, sessionId: 'owner' })).toEqual([]);
    expect(verifyViolations(base, { existingEvidence: new Set(['evidence/a.md']), sessionId: 'owner' }).join()).toContain('c2');
    const unmet = { ...base, success_criteria: [{ ...base.success_criteria[0]!, met: false }] };
    expect(verifyViolations(unmet, { existingEvidence: evidence, sessionId: 'owner' }).join()).toContain('not met');
    expect(verifyViolations(base, { existingEvidence: evidence, sessionId: 'ver' }).join()).toContain('owner');
    const full = { ...base, sessions: [...base.sessions, { id: 'a', role: 'owner' as const, since: 'x' }, { id: 'b', role: 'verifier' as const, since: 'x' }] };
    expect(verifyViolations(full, { existingEvidence: evidence, sessionId: 'a' }).join()).toContain('max_sessions');
  });

  test('only the current verifier, never an owner, gives the verdict; PASS needs a PASS report', () => {
    const ok = { sessionId: 'ver', verification: 'c1 PASS\nc2 PASS' };
    expect(verdictViolations(verifying, 'pass', 'checked', ok)).toEqual([]);
    expect(verdictViolations(verifying, 'pass', 'checked', { ...ok, sessionId: 'owner' })[0]).toContain('verifier');
    expect(verdictViolations(verifying, 'pass', 'checked', { ...ok, verification: 'c1 PASS\nc2 FAIL' })[0]).toContain('PASS');
    expect(verdictViolations(verifying, 'pass', 'checked', { ...ok, verification: null })[0]).toContain('verification.md');
    expect(verdictViolations(verifying, 'fail', 'c2 has no EUR charge', { ...ok, verification: null })[0]).toContain('verification.md');
    expect(verdictViolations(base, 'fail', 'x', ok)[0]).toContain('verifying');
    // The owner listed again as verifier still did the work.
    const selfCheck = { ...verifying, sessions: [...verifying.sessions, { id: 'owner', role: 'verifier' as const, since: 'x' }] };
    expect(verdictViolations(selfCheck, 'pass', 'x', { ...ok, sessionId: 'owner' })[0]).toContain('did the work');
  });

  test('wakes are counted per UTC day; the cap is reached at max_wakes_per_day', () => {
    const day = new Date('2026-10-28T10:00:00Z');
    const one = recordWake(base, day);
    expect(one).toMatchObject({ capped: false, doc: { wake_day: '2026-10-28', wake_count: 1 } });
    const three = recordWake(recordWake(one.doc, day).doc, day);
    expect(three).toMatchObject({ capped: true, doc: { wake_count: 3 } });
    expect(recordWake(three.doc, new Date('2026-10-29T00:05:00Z'))).toMatchObject({ capped: false, doc: { wake_day: '2026-10-29', wake_count: 1 } });
  });

  test('check: done needs a PASS and a verifier that is not an owner; a status edited by hand is caught', () => {
    const done = { ...verifying, status: 'done' as const, verified_by: 'ver', transitions: [...verifying.transitions, { from: 'verifying' as const, to: 'done' as const, at: 'x', reason: 'PASS', by: 'ver' }] };
    expect(goalViolations(done, { verification: 'c1 PASS' })).toEqual([]);
    expect(goalViolations({ ...done, verified_by: 'owner' }, { verification: 'c1 PASS' }).join()).toContain('owner');
    expect(goalViolations(done, { verification: 'c1 FAIL' }).join()).toContain('PASS');
    expect(goalViolations({ ...base, status: 'done' }, { verification: null }).join()).toContain('edited by hand');
    expect(goalViolations(null, { verification: null })[0]).toContain('GOAL.md');
  });
});

test('slugify keeps the first five words', () => {
  expect(slugify('Secure €2.5M EIC Accelerator funding for the company')).toBe('secure-2-5m-eic-accelerator');
});

test('goals need goals, volumes and reminders on', () => {
  expect(missingGoalFlags({ goals: true, volumes: true, reminders: true })).toEqual([]);
  expect(missingGoalFlags(undefined)).toEqual(['goals', 'volumes', 'reminders']);
});

test('enforcement prompts are capped at 3 per goal per 6 hours', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'goal-check-')), 'state.json');
  const t = 1_000_000_000_000;
  expect([1, 2, 3, 4].map((i) => takeEnforcementSlot('/g', t + i, state))).toEqual([true, true, true, false]);
  expect(takeEnforcementSlot('/g', t + 6 * 60 * 60_000 + 10, state)).toBe(true);
});

// ── The real CLI process against a fake API ──────────────────────────────────

interface Fake {
  requests: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  reminders: Array<{ id: string; prompt: string; state: string; next_fire_at: string | null }>;
  url: string;
  stop(): void;
}

function fakeApi(): Fake {
  const fake: Omit<Fake, 'url' | 'stop'> = { requests: [], reminders: [] };
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
      fake.requests.push({ method: req.method, path: pathname, body });
      const reminder = /^\/v1\/projects\/p1\/sessions\/([^/]+)\/reminders(?:\/([^/]+))?$/.exec(pathname);
      if (reminder && req.method === 'GET') return Response.json({ reminders: fake.reminders });
      if (reminder && req.method === 'POST') {
        const next = (body.at as string) ?? new Date(Date.now() + 4 * 3_600_000).toISOString();
        const r = { id: `reminder.${String(++n).padStart(12, '0')}`, prompt: String(body.prompt), state: 'active', next_fire_at: next };
        fake.reminders.push(r);
        return Response.json(r);
      }
      if (reminder && req.method === 'DELETE') {
        fake.reminders = fake.reminders.filter((r) => r.id !== reminder[2]);
        return Response.json({ ok: true });
      }
      if (/^\/v1\/projects\/p1\/sessions\/[^/]+$/.test(pathname)) {
        return Response.json({ session_id: pathname.split('/').at(-1), created_by: 'u1', agent_name: 'billing', metadata: { unattended: 'true' } });
      }
      if (pathname === '/v1/projects/p1/sessions' && req.method === 'POST') return Response.json({ session_id: `new-${++n}`, status: 'pending' });
      if (/\/prompts$/.test(pathname)) return Response.json({ prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    },
  });
  return Object.assign(fake as Fake, { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) });
}

async function cli(fake: Fake, root: string, sessionId: string, args: string[]) {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', ...args], {
    env: {
      ...process.env,
      HOME: root,
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_API_URL: fake.url,
      KORTIX_TOKEN: 'kortix_pat_session',
      KORTIX_PROJECT_ID: 'p1',
      KORTIX_SESSION_ID: sessionId,
      KORTIX_AGENT_NAME: 'billing',
      KORTIX_FEATURE_FLAGS: 'goals,reminders,volumes',
      KORTIX_DRIVES_ROOT: join(root, 'drives'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out: stdout + stderr };
}

test('the real CLI runs a goal end to end: new, active, verify, a FAIL back to active, verify again, PASS → done', async () => {
  const fake = fakeApi();
  const root = mkdtempSync(join(tmpdir(), 'goals-e2e-'));
  mkdirSync(join(root, 'drives', 'company'), { recursive: true });
  const folder = join(root, 'drives', 'company', 'Goals', 'eu-billing');
  const read = () => parseGoalFile(readFileSync(join(folder, 'GOAL.md'), 'utf8'))!;
  const write = (doc: ProjectGoalDocument) => writeFileSync(join(folder, 'GOAL.md'), formatGoalFile(doc));
  try {
    const created = await cli(fake, root, 'owner', ['new', 'EU billing live', '--slug', 'eu-billing']);
    expect(created.out).toContain('Goal created');
    expect(created.code).toBe(0);
    expect(read()).toMatchObject({ status: 'draft', assigned_user: 'u1', agent: 'billing', heartbeat_every: '4h', sessions: [{ id: 'owner', role: 'owner' }] });
    expect(fake.reminders[0]!.prompt).toContain(`Goal wake: ${folder}.`);
    expect(existsSync(join(folder, 'log.md')) && existsSync(join(folder, 'evidence'))).toBe(true);

    write({ ...read(), success_criteria: base.success_criteria });
    expect((await cli(fake, root, 'owner', ['transition', 'active', '--reason', 'criteria written'])).code).toBe(0);

    // Evidence missing: verify refuses and starts nobody.
    const early = await cli(fake, root, 'owner', ['verify']);
    expect(early.code).toBe(1);
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/projects/p1/sessions')).toBe(false);

    writeFileSync(join(folder, 'evidence', 'a.md'), 'invoice');
    writeFileSync(join(folder, 'evidence', 'b.md'), 'charge');
    const verify = await cli(fake, root, 'owner', ['verify', '--json']);
    expect(verify.code).toBe(0);
    const spawn = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/projects/p1/sessions')!;
    expect(spawn.body).toMatchObject({ agent_name: 'billing', metadata: { unattended: 'true', goal_role: 'verifier' } });
    expect(spawn.body.initial_context).toBeUndefined();
    const verifier = read().sessions.at(-1)!;
    expect(read().status).toBe('verifying');
    expect(verifier.role).toBe('verifier');

    // The owner cannot pass its own goal.
    writeFileSync(join(folder, 'evidence', 'verification.md'), 'c1 PASS\nc2 FAIL: charged in USD');
    expect((await cli(fake, root, 'owner', ['verdict', 'pass', '--reason', 'done'])).code).not.toBe(0);
    expect(read().status).toBe('verifying');
    const fail = await cli(fake, root, verifier.id, ['verdict', 'fail', '--reason', 'c2: charged in USD']);
    expect(fail.code).toBe(0);
    expect(read().status).toBe('active');
    expect(readFileSync(join(folder, 'log.md'), 'utf8')).toContain('c2: charged in USD');

    const again = await cli(fake, root, 'owner', ['verify', '--json']);
    expect(again.code).toBe(0);
    const second = read().sessions.at(-1)!;
    expect(second.id).not.toBe(verifier.id);
    // max_sessions defaults to 10; this goal used 3.
    writeFileSync(join(folder, 'evidence', 'verification.md'), 'c1 PASS\nc2 PASS');
    const pass = await cli(fake, root, second.id, ['verdict', 'pass', '--reason', 'both checked']);
    expect(pass.code).toBe(0);
    expect(read()).toMatchObject({ status: 'done', verified_by: second.id });

    // The owner's next turn end removes the heartbeat of the closed goal.
    expect(fake.reminders).toHaveLength(1);
    await cli(fake, root, 'owner', ['check', '--enforce', '--quiet']);
    expect(fake.reminders).toHaveLength(0);
  } finally {
    fake.stop();
  }
});

test('check --enforce re-arms a missing heartbeat, counts wakes and, at the cap, moves the heartbeat to the next UTC day', async () => {
  const fake = fakeApi();
  const root = mkdtempSync(join(tmpdir(), 'goals-cap-'));
  const folder = join(root, 'drives', 'company', 'Goals', 'eu-billing');
  mkdirSync(join(folder, 'evidence'), { recursive: true });
  writeFileSync(join(folder, 'GOAL.md'), formatGoalFile({ ...base, reminder_id: null, max_wakes_per_day: 2 }));
  writeFileSync(join(folder, 'log.md'), '# Log\n');
  const read = () => parseGoalFile(readFileSync(join(folder, 'GOAL.md'), 'utf8'))!;
  try {
    expect((await cli(fake, root, 'owner', ['check', '--enforce', '--quiet'])).code).toBe(0);
    expect(fake.reminders).toHaveLength(1);
    expect(read()).toMatchObject({ reminder_id: fake.reminders[0]!.id, wake_count: 1 });

    await cli(fake, root, 'owner', ['check', '--enforce', '--quiet']);
    expect(read().wake_count).toBe(2);
    expect(fake.reminders).toHaveLength(1);
    const deferred = fake.reminders[0]!;
    expect(deferred.next_fire_at).toMatch(/T00:00:00(\.000)?Z$/);
    expect(read().next_wake_at).toBe(deferred.next_fire_at);
    expect(readFileSync(join(folder, 'log.md'), 'utf8')).toContain('wake cap');
    // No [GOAL CHECK] prompt for a repair the CLI did itself.
    expect(fake.requests.some((r) => r.path.endsWith('/prompts'))).toBe(false);

    // A session that is not the owner changes nothing.
    await cli(fake, root, 'worker', ['check', '--enforce', '--quiet']);
    expect(read().wake_count).toBe(2);
  } finally {
    fake.stop();
  }
});

test('handover starts a fresh owner with the note, records it, and drops the old heartbeat', async () => {
  const fake = fakeApi();
  const root = mkdtempSync(join(tmpdir(), 'goals-handover-'));
  const folder = join(root, 'drives', 'company', 'Goals', 'eu-billing');
  mkdirSync(join(folder, 'evidence'), { recursive: true });
  fake.reminders.push({ id: 'reminder.aaaaaaaaaaaa', prompt: `Goal wake: ${folder}. Load the kortix-goals skill and run one wake.`, state: 'active', next_fire_at: null });
  writeFileSync(join(folder, 'GOAL.md'), formatGoalFile({ ...base, max_sessions: 5 }));
  writeFileSync(join(folder, 'log.md'), '# Log\n');
  const read = () => parseGoalFile(readFileSync(join(folder, 'GOAL.md'), 'utf8'))!;
  try {
    const out = await cli(fake, root, 'owner', ['handover', '--note', 'Invoices done; checkout next.']);
    expect(out.code).toBe(0);
    const spawn = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/projects/p1/sessions')!;
    expect(String(spawn.body.initial_prompt)).toContain(`Goal wake: ${folder}.`);
    expect(spawn.body.metadata).toMatchObject({ goal_role: 'owner', goal: folder });
    expect(read().sessions.at(-1)).toMatchObject({ role: 'owner' });
    expect(read().sessions.at(-1)!.id).not.toBe('owner');
    expect(read().reminder_id).toBeNull();
    expect(fake.reminders).toHaveLength(0);
    expect(readFileSync(join(folder, 'log.md'), 'utf8')).toContain('Invoices done; checkout next.');
    // The old owner no longer moves the goal.
    expect((await cli(fake, root, 'owner', ['transition', 'stopped', '--reason', 'x'])).code).not.toBe(0);
    expect(read().status).toBe('active');
  } finally {
    fake.stop();
  }
});

test('the goals flag gates the real CLI in a box: off hides and refuses kortix goals', () => {
  const run = (args: string[], flags: string) =>
    Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), ...args], {
      env: { ...process.env, KORTIX_FEATURE_FLAGS: flags, KORTIX_DRIVES_ROOT: join(tmpdir(), 'no-drives-here') },
    });
  const out = (r: ReturnType<typeof run>) => r.stdout.toString() + r.stderr.toString();
  expect(out(run(['--help'], 'volumes,reminders'))).not.toMatch(/^\s+goals\s/m);
  const off = run(['goals', 'ls'], 'volumes,reminders');
  expect(off.exitCode).not.toBe(0);
  expect(out(off)).toContain('kortix projects features enable goals');
  const on = run(['goals', '--help'], 'volumes,reminders,goals');
  expect(on.exitCode).toBe(0);
  expect(out(on)).toContain('Usage: kortix goals');
});

test('ls and status read GOAL.md, and a legacy goal.json folder still lists', () => {
  const root = mkdtempSync(join(tmpdir(), 'drives-'));
  const folder = join(root, 'company', 'Goals', 'eu-billing');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'GOAL.md'), formatGoalFile({ ...base, status: 'waiting_on_user', waiting_on: 'Which VAT id do we invoice from?' }));
  const legacy = join(root, 'me', 'Goals', 'old');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'goal.json'), JSON.stringify({ version: 1, objective: 'Old', status: 'active', success_criteria: [], items: [], sessions: [] }));
  const run = (args: string[]) =>
    Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', ...args], {
      env: { ...process.env, KORTIX_FEATURE_FLAGS: 'goals', KORTIX_DRIVES_ROOT: root },
    });
  const ls = run(['ls', '--json']);
  expect(ls.exitCode).toBe(0);
  const goals = JSON.parse(ls.stdout.toString()).goals;
  expect(goals.map((g: { slug: string }) => g.slug)).toEqual(['eu-billing', 'old']);
  expect(goals[0]).toMatchObject({ status: 'waiting_on_user', criteria_met: 2, criteria_total: 2, waiting_on: 'Which VAT id do we invoice from?' });
  const st = run(['status', 'eu-billing']);
  expect(st.exitCode).toBe(0);
  expect(st.stdout.toString()).toContain('Which VAT id do we invoice from?');
});
