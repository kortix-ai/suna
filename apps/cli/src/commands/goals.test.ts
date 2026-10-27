import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalViolations, slugify, takeEnforcementSlot, type GoalFacts } from './goals';

const base = {
  version: 1,
  objective: 'Rho account closed',
  status: 'active',
  success_criteria: [{ id: 'c1', text: 'Rho confirms in writing', met: false, evidence: null }],
  items: [{ id: 'i1', kind: 'ask', title: 'Approve 2FA', status: 'open' }],
  sessions: [{ id: 'coord', role: 'coordinator' }],
  reminder_id: 'reminder.a',
  verified_by: null,
};
const healthy: GoalFacts = { activeHeartbeats: ['reminder.a'], unattended: true, verification: null };

describe('goalViolations', () => {
  test('a sound open goal passes', () => {
    expect(goalViolations(base, healthy)).toEqual([]);
  });

  test('an open goal without a heartbeat, or not unattended, fails with the fix', () => {
    const v = goalViolations(base, { ...healthy, activeHeartbeats: [], unattended: false });
    expect(v.join('\n')).toContain('no heartbeat reminder is active');
    expect(v.join('\n')).toContain('kortix sessions update --meta unattended=true');
  });

  test('done needs an independent PASS and no heartbeat left', () => {
    const done = { ...base, status: 'done', verified_by: 'coord' };
    const v = goalViolations(done, { ...healthy, verification: 'c1: FAIL' });
    expect(v.join('\n')).toContain('not PASS on every criterion');
    expect(v.join('\n')).toContain('only a session that did none of the work may verify');
    expect(v.join('\n')).toContain('still active');
    expect(goalViolations({ ...done, verified_by: 'verifier' }, { activeHeartbeats: [], unattended: true, verification: 'c1: PASS' })).toEqual([]);
  });

  test('schema: version, status, criteria and item enums', () => {
    const v = goalViolations({ ...base, version: 2, status: 'finished', success_criteria: [], items: [{ id: 'x', kind: 'todo', status: 'later' }] }, healthy);
    expect(v).toHaveLength(5);
    expect(goalViolations(null, healthy)).toEqual(['goal.json is not a JSON object.']);
  });
});

test('slugify keeps the first five words', () => {
  expect(slugify('Secure €2.5M EIC Accelerator funding for the company')).toBe('secure-2-5m-eic-accelerator');
});

test('enforcement is capped at 3 prompts per goal per 6 hours', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'goal-check-')), 'state.json');
  const t = 1_000_000_000_000;
  expect([1, 2, 3, 4].map((i) => takeEnforcementSlot('/g', t + i, state))).toEqual([true, true, true, false]);
  expect(takeEnforcementSlot('/other', t, state)).toBe(true);
  expect(takeEnforcementSlot('/g', t + 6 * 60 * 60_000 + 10, state)).toBe(true);
});

test('the real CLI lists and shows goals from the mounted folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drives-'));
  const folder = join(root, 'me', 'Goals', 'rho-close');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'goal.json'), JSON.stringify({ ...base, summary: 'Closure requested.', next_wake_at: '2026-10-20T09:00:00Z' }));
  const run = (args: string[]) =>
    Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', ...args], { env: { ...process.env, KORTIX_FEATURE_FLAGS: 'goals', KORTIX_DRIVES_ROOT: root } });
  const ls = run(['ls', '--json']);
  expect(ls.exitCode).toBe(0);
  expect(JSON.parse(ls.stdout.toString()).goals[0]).toMatchObject({ slug: 'rho-close', status: 'active', criteria_total: 1, criteria_met: 0 });
  const st = run(['status', 'rho-close']);
  expect(st.exitCode).toBe(0);
  expect(st.stdout.toString()).toContain('Approve 2FA');
  const missingRoot = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', 'ls'], { env: { ...process.env, KORTIX_FEATURE_FLAGS: 'goals', KORTIX_DRIVES_ROOT: join(root, 'nope') } });
  expect(missingRoot.exitCode).toBe(2);
  expect(missingRoot.stderr.toString() + missingRoot.stdout.toString()).toContain('Files is not mounted here');
});

describe('transitionViolations (the goal state machine)', () => {
  const { transitionViolations } = require('./goals') as typeof import('./goals');
  const facts = { activeHeartbeats: ['reminder.a'], unattended: true, verification: null, existingEvidence: new Set<string>() };
  const draft = { ...base, status: 'draft', success_criteria: [] as typeof base.success_criteria };
  const two = [
    { id: 'c1', text: 'a', met: true, evidence: 'evidence/a.md' },
    { id: 'c2', text: 'b', met: true, evidence: 'evidence/b.md' },
  ];

  test('only listed edges exist; closed goals have none; every transition needs a reason', () => {
    expect(transitionViolations({ ...base }, 'done', 'x', facts)[0]).toContain('active → done is not a transition');
    expect(transitionViolations({ ...base, status: 'done' }, 'active', 'x', facts)[0]).toContain('none (closed)');
    expect(transitionViolations({ ...base }, 'waiting_on_user', ' ', facts)[0]).toContain('--reason');
    expect(transitionViolations({ ...base }, 'abandoned', 'user said stop', facts)).toEqual([]);
  });

  test('draft → active needs 2-6 criteria, one heartbeat and unattended', () => {
    expect(transitionViolations(draft, 'active', 'planned', { ...facts, unattended: false }).length).toBe(2);
    expect(transitionViolations({ ...draft, success_criteria: two }, 'active', 'planned', facts)).toEqual([]);
  });

  test('waiting_on_user needs an open ask with owner and due', () => {
    expect(transitionViolations(base, 'waiting_on_user', 'asked', facts)[0]).toContain('needs an "owner" and a "due"');
    const asked = { ...base, items: [{ id: 'i1', kind: 'ask', title: 'x', status: 'open', owner: 'user', due: '2026-10-20T09:00:00Z' }] };
    expect(transitionViolations(asked, 'waiting_on_user', 'asked', facts)).toEqual([]);
  });

  test('verifying needs met criteria with existing evidence and a verifier; done needs its PASS', () => {
    const ready = { ...base, success_criteria: two };
    expect(transitionViolations(ready, 'verifying', 'all met', facts).join('\n')).toContain('no existing evidence');
    const withVerifier = { ...ready, sessions: [...base.sessions, { id: 'ver', role: 'verifier' }] };
    expect(transitionViolations(withVerifier, 'verifying', 'all met', { ...facts, existingEvidence: new Set(['evidence/a.md', 'evidence/b.md']) })).toEqual([]);
    const verifying = { ...withVerifier, status: 'verifying', verified_by: 'ver' };
    expect(transitionViolations(verifying, 'done', 'pass', { ...facts, verification: 'c1 FAIL' })).toHaveLength(1);
    expect(transitionViolations({ ...verifying, verified_by: 'coord' }, 'done', 'pass', { ...facts, verification: 'PASS' })).toHaveLength(1);
    expect(transitionViolations(verifying, 'done', 'pass', { ...facts, verification: 'c1 PASS, c2 PASS' })).toEqual([]);
  });

  test('check flags a status edited by hand', () => {
    const edited = { ...base, transitions: [{ from: null, to: 'draft', at: 'x', reason: 'r', by: 'coord' }] };
    expect(goalViolations(edited, healthy).join('\n')).toContain('edited by hand');
  });
});

test('goals need goals, volumes and reminders on', () => {
  const { missingGoalFlags } = require('./goals') as typeof import('./goals');
  expect(missingGoalFlags({ goals: true, volumes: true, reminders: true })).toEqual([]);
  expect(missingGoalFlags({ goals: false, volumes: true, reminders: true })).toEqual(['goals']);
  expect(missingGoalFlags(undefined)).toEqual(['goals', 'volumes', 'reminders']);
});

test('check reports fields code does not read, in goal.json and in items', () => {
  const v = goalViolations({ ...base, constraints: ['x'], items: [{ ...base.items[0], nag_every: '1d' }] }, healthy).join('\n');
  expect(v).toContain('unknown field(s) constraints');
  expect(v).toContain('item i1: unknown field(s) nag_every');
});

test('the goals flag gates the real CLI in a box: off hides and refuses kortix goals, on shows and runs it', () => {
  const cli = (args: string[], flags: string) =>
    Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), ...args], {
      env: { ...process.env, KORTIX_FEATURE_FLAGS: flags, KORTIX_DRIVES_ROOT: join(tmpdir(), 'no-drives-here') },
    });
  const out = (r: ReturnType<typeof cli>) => r.stdout.toString() + r.stderr.toString();

  const offHelp = cli(['--help'], 'volumes,reminders');
  expect(out(offHelp)).not.toMatch(/^\s+goals\s/m);
  const off = cli(['goals', 'ls'], 'volumes,reminders');
  expect(off.exitCode).not.toBe(0);
  expect(out(off)).toContain('kortix projects features enable goals');

  const onHelp = cli(['--help'], 'volumes,reminders,goals');
  expect(out(onHelp)).toMatch(/^\s+goals\s/m);
  const on = cli(['goals', '--help'], 'volumes,reminders,goals');
  expect(on.exitCode).toBe(0);
  expect(out(on)).toContain('Usage: kortix goals');
});

test('goals new in a box without repository access: flags come from the box, the project record is never read', async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      requests.push(`${req.method} ${pathname}`);
      if (req.method === 'GET' && pathname === '/v1/projects/p1') {
        return Response.json({ error: true, message: 'session workspace does not allow repository access', status: 403 }, { status: 403 });
      }
      if (req.method === 'PATCH' && pathname === '/v1/projects/p1/sessions/s1') return Response.json({});
      if (req.method === 'POST' && pathname === '/v1/projects/p1/sessions/s1/reminders') {
        return Response.json({ id: 'reminder.x', next_fire_at: '2026-10-22T00:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'goals-norepo-'));
  mkdirSync(join(root, 'drives', 'company'), { recursive: true });
  try {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', 'new', 'Probe objective', '--shared'], {
      env: {
        ...process.env,
        HOME: root,
        KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
        KORTIX_TOKEN: 'kortix_pat_session',
        KORTIX_PROJECT_ID: 'p1',
        KORTIX_SESSION_ID: 's1',
        KORTIX_FEATURE_FLAGS: 'goals,reminders,volumes',
        KORTIX_DRIVES_ROOT: join(root, 'drives'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(`${code} ${stdout}${stderr}`).toContain('0 ');
    expect(stdout).toContain('Goal created');
    expect(requests).not.toContain('GET /v1/projects/p1');
    expect(requests).toContain('POST /v1/projects/p1/sessions/s1/reminders');
  } finally {
    server.stop(true);
  }
});
