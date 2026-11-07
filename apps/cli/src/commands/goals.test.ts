import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceGoalCriterionStatus } from '@kortix/sdk';
import {
  briefCriteria,
  chaseViolations,
  evidencePathOk,
  goalProblems,
  progressCriteria,
  takeEnforcementSlot,
  verdictResults,
  withLifecycleMirror,
  type Goal,
} from './goals';

// ── Pure rules ───────────────────────────────────────────────────────────────

const crit = (id: string, over: Partial<WorkspaceGoalCriterionStatus> = {}): WorkspaceGoalCriterionStatus => ({ id, text: `criterion ${id}`, reported_met: false, evidence: null, verified: false, ...over });

describe('verdict flags', () => {
  const criteria = [crit('c1'), crit('c2'), crit('c3')];
  const none = { pass: [], fail: [], inconclusive: [], notes: [], reason: '' };

  test('one result per current criterion, notes carried by id', () => {
    const r = verdictResults(criteria, { ...none, pass: ['c1', 'c2'], fail: ['c3'], notes: ['c3=charged in USD'] });
    expect(r.violations).toEqual([]);
    expect(r.results).toEqual([
      { criterion_id: 'c1', result: 'pass', note: '' },
      { criterion_id: 'c2', result: 'pass', note: '' },
      { criterion_id: 'c3', result: 'fail', note: 'charged in USD' },
    ]);
  });

  test('a missing, duplicate or unknown criterion is refused; a fail needs a note', () => {
    expect(verdictResults(criteria, { ...none, pass: ['c1', 'c2'] }).violations.join()).toContain('c3 has no result');
    expect(verdictResults(criteria, { ...none, pass: ['c1', 'c2', 'c3'], fail: ['c3'], notes: ['c3=x'] }).violations.join()).toContain('two results');
    expect(verdictResults(criteria, { ...none, pass: ['c1', 'c2', 'c3', 'c9'] }).violations.join()).toContain('No criterion c9');
    expect(verdictResults(criteria, { ...none, pass: ['c1', 'c2'], fail: ['c3'] }).violations.join()).toContain('--note c3=');
    expect(verdictResults(criteria, { ...none, pass: ['c1', 'c2'], fail: ['c3'], reason: 'see report' }).violations).toEqual([]);
  });
});

test('progress: evidence must sit under evidence/ without ".."; ids must exist', () => {
  expect(evidencePathOk('evidence/invoice.pdf')).toBe(true);
  for (const bad of ['evidence/', '../evidence/x', 'evidence/../GOAL.md', '/evidence/x', 'notes/x.md', 'evidence//x']) expect(evidencePathOk(bad)).toBe(false);
  const criteria = [crit('c1'), crit('c2', { reported_met: true })];
  expect(progressCriteria(criteria, { met: ['c1'], unmet: [], evidence: ['c1=evidence/a.md', 'c2=evidence/b.md'] }).criteria).toEqual([
    { id: 'c1', reported_met: true, evidence: 'evidence/a.md' },
    { id: 'c2', reported_met: true, evidence: 'evidence/b.md' },
  ]);
  expect(progressCriteria(criteria, { met: ['c7'], unmet: [], evidence: [] }).violations.join()).toContain('No criterion c7');
  expect(progressCriteria(criteria, { met: [], unmet: [], evidence: ['c1=../x'] }).violations.join()).toContain('under evidence/');
});

test('--chase-at is an ISO time 60 minutes to 14 days ahead', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  expect(chaseViolations(undefined, now)).toEqual([]);
  expect(chaseViolations('2026-11-07T10:00:00Z', now)).toEqual([]);
  expect(chaseViolations('2026-11-06T10:30:00Z', now)[0]).toContain('60 minutes');
  expect(chaseViolations('2026-12-06T10:00:00Z', now)[0]).toContain('14 days');
  expect(chaseViolations('tomorrow', now)[0]).toContain('ISO 8601');
});

test('the brief: criteria come from "## Done criteria", never from lifecycle keys', () => {
  const text = ['---', 'goal_id: g1', 'state: done', '---', '# EU billing', '', '## Done criteria', '', '- c1: Invoice shows EUR', '2. [ ] Checkout charges EUR', '', '## Context', '- not a criterion'].join('\n');
  expect(briefCriteria(text)).toEqual(['Invoice shows EUR', 'Checkout charges EUR']);
});

test('the lifecycle mirror replaces itself and keeps the rest of the front matter', () => {
  const g = { state: 'active' as const, revision: 3, owner_session_id: 's1', paused_at: null };
  const once = withLifecycleMirror('---\ngoal_id: g1\n---\n# Brief\n', g);
  const twice = withLifecycleMirror(once, { ...g, revision: 4 });
  expect(twice).toContain('goal_id: g1');
  expect(twice).toContain('lifecycle_revision: 4');
  expect(twice).not.toContain('lifecycle_revision: 3');
  expect(twice.match(/read-only mirror/g)).toHaveLength(1);
  expect(twice.endsWith('---\n# Brief\n')).toBe(true);
  expect(withLifecycleMirror('# No front matter\n', g).startsWith('---\n# kortix-lifecycle')).toBe(true);
});

test('check problems: a draft, or an active goal with nothing reported for 3 wakes; a paused goal has none', () => {
  const base = { state: 'active', paused_at: null, criteria: [crit('c1')] } as unknown as Goal;
  expect(goalProblems({ ...base, state: 'draft', criteria: [] })[0]).toContain('no done criteria');
  expect(goalProblems({ ...base, state: 'draft' })[0]).toContain('Still a draft');
  expect(goalProblems(base)).toEqual([]);
  // An active goal is never nudged: its wakes come from the API's admitted heartbeat (wake cap).
  expect(goalProblems(base)).toEqual([]);
  expect(goalProblems({ ...base, paused_at: '2026-11-06T00:00:00Z' })).toEqual([]);
  expect(goalProblems({ ...base, state: 'waiting_on_user' })).toEqual([]);
});

test('enforcement prompts are capped at 3 per goal per 6 hours', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'goal-check-')), 'state.json');
  const t = 1_000_000_000_000;
  expect([1, 2, 3, 4].map((i) => takeEnforcementSlot('g1', t + i, state))).toEqual([true, true, true, false]);
  expect(takeEnforcementSlot('g1', t + 6 * 60 * 60_000 + 10, state)).toBe(true);
});

// ── The real CLI process against a fake Goals API ────────────────────────────
// The fake applies the spec's actor rules from the bearer token
// (`session:<id>` = that session, anything else = a person) and the
// compare-and-set on `revision`.

interface Req {
  method: string;
  path: string;
  search: string;
  actor: string;
  body: Record<string, unknown>;
}

/** The fake's goal row: the record plus the row's current verifier, which the wire carries only in `verification`. */
type FakeGoal = Goal & { verifier_session_id: string | null };

interface Fake {
  goal: FakeGoal;
  requests: Req[];
  sessionMeta: Record<string, Record<string, unknown>>;
  /** Bump the revision before the next write, as a concurrent person edit would. */
  conflictNext: ((g: FakeGoal) => void) | null;
  /** Answer a request before the fake's own rules: a route that is off, or a stale revision on every write. */
  respond: ((r: Req) => Response | null) | null;
  writes(): Req[];
  url: string;
  stop(): void;
}

const GOAL_ID = '00000000-0000-4000-8000-000000000001';

function goalRecord(box: string, over: Partial<FakeGoal> = {}): FakeGoal {
  return {
    goal_id: GOAL_ID,
    project_id: 'p1',
    revision: 1,
    title: 'EU billing live',
    state: 'draft',
    waiting_on: null,
    chase_at: null,
    summary: '',
    paused_at: null,
    paused_by_user_id: null,
    stopped_at: null,
    blocked_reason: null,
    assigned_user_id: 'u1',
    created_by_user_id: 'u1',
    agent: 'billing',
    space: null,
    drive_id: 'd1',
    folder: '/Users/u1/Goals/eu-billing',
    box_folder: box,
    slug: 'eu-billing',
    owner_session_id: 'owner',
    verifier_session_id: null,
    sessions: [{ id: 'owner', role: 'owner', since: '2026-11-06T08:00:00Z' }],
    criteria_revision: 0,
    criteria: [],
    verification: null,
    heartbeat_every: '4h',
    next_wake_at: null,
    last_wake_at: null,
    max_wakes_per_day: 12,
    wakes_today: 0,
    max_sessions: 10,
    provenance: 'api',
    created_at: '2026-11-06T08:00:00Z',
    updated_at: '2026-11-06T08:00:00Z',
    capabilities: { read: true, edit: true, pause: true, resume: true, stop: true, restart: true, answer: true, edit_criteria: true },
    ...over,
  };
}

function fakeApi(start: FakeGoal): Fake {
  const fake = { goal: start, requests: [] as Req[], sessionMeta: {} as Record<string, Record<string, unknown>>, conflictNext: null as Fake['conflictNext'], respond: null as Fake['respond'] };
  let n = 0;
  const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => Response.json({ error, message, ...extra }, { status });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const actor = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/, '');
      const session = actor.startsWith('session:') ? actor.slice(8) : null;
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
      const recorded = { method: req.method, path: url.pathname, search: url.search, actor, body };
      fake.requests.push(recorded);
      const override = fake.respond?.(recorded);
      if (override) return override;
      const g = fake.goal;
      const ok = (next: Partial<FakeGoal>) => {
        fake.goal = { ...fake.goal, ...next, revision: fake.goal.revision + 1 };
        return Response.json({ goal: fake.goal });
      };

      const sessionPath = /^\/v1\/workspaces\/p1\/sessions\/([^/]+)$/.exec(url.pathname);
      if (sessionPath && req.method === 'GET') return Response.json({ session_id: sessionPath[1], metadata: fake.sessionMeta[sessionPath[1]!] ?? {}, agent_name: 'billing' });
      if (/\/sessions\/[^/]+\/prompts$/.test(url.pathname)) return Response.json({ prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false });

      if (url.pathname === '/v1/workspaces/p1/goals' && req.method === 'GET') {
        const owner = url.searchParams.get('owner_session_id');
        const verifier = url.searchParams.get('verifier_session_id');
        const match = (owner === null || g.owner_session_id === owner) && (verifier === null || g.verifier_session_id === verifier);
        return Response.json({ goals: match ? [g] : [] });
      }
      if (url.pathname === '/v1/workspaces/p1/goals' && req.method === 'POST') {
        return session ? err(403, 'goal_forbidden', 'A session cannot create a goal.') : Response.json({ goal: g }, { status: 201 });
      }
      const m = /^\/v1\/workspaces\/p1\/goals\/([^/]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
      if (!m || m[1] !== g.goal_id) return err(404, 'goal_not_found', 'No such goal.');
      const action = m[2] ?? '';
      if (req.method === 'GET' && !action) return Response.json({ goal: g });

      fake.conflictNext?.(fake.goal);
      fake.conflictNext = null;
      if (body.revision !== fake.goal.revision) return err(409, 'goal_conflict', 'The goal changed.', { goal: fake.goal });
      const isOwner = session !== null && session === g.owner_session_id;
      const forbidden = () => err(403, 'goal_forbidden', `Session ${session ?? '(person)'} may not ${action || 'edit'} this goal.`);

      if (req.method === 'PATCH' && !action) {
        if (session) return forbidden();
        const { revision: _revision, ...binding } = body;
        return ok(binding);
      }
      if (req.method === 'PUT' && action === 'criteria') {
        if (!(isOwner && g.state === 'draft')) return forbidden();
        const texts = body.criteria as string[];
        return ok({ criteria: texts.map((text, i) => ({ id: `c${i + 1}`, text, reported_met: false, evidence: null, verified: false })), criteria_revision: g.criteria_revision + 1 });
      }
      if (action === 'activate') {
        if (!isOwner) return forbidden();
        if (!['draft', 'waiting_on_user'].includes(g.state) || !g.criteria.length) return err(422, 'goal_invalid', 'Cannot activate.', { violations: ['not a draft or waiting goal with criteria'] });
        return ok({ state: 'active', waiting_on: null, chase_at: null });
      }
      if (action === 'wait') {
        if (!isOwner) return forbidden();
        return ok({ state: 'waiting_on_user', waiting_on: String(body.question), chase_at: (body.chase_at as string) ?? null });
      }
      if (action === 'progress') {
        if (!isOwner) return forbidden();
        const updates = new Map(((body.criteria as Array<{ id: string; reported_met: boolean; evidence?: string }>) ?? []).map((c) => [c.id, c]));
        return ok({
          summary: (body.summary as string) ?? g.summary,
          criteria: g.criteria.map((c) => (updates.has(c.id) ? { ...c, reported_met: updates.get(c.id)!.reported_met, evidence: updates.get(c.id)!.evidence ?? c.evidence } : c)),
        });
      }
      if (action === 'request-verification') {
        if (!isOwner) return forbidden();
        const missing = g.criteria.filter((c) => !c.reported_met || !c.evidence).map((c) => `Criterion ${c.id} has no evidence.`);
        if (missing.length) return err(422, 'goal_invalid', 'Not ready for verification.', { violations: missing });
        const id = `ver-${++n}`;
        const attempt = (g.verification?.attempt ?? 0) + 1;
        const verification = { attempt, outcome: 'pending' as const, verifier_session_id: id, criteria_revision: g.criteria_revision, started_at: 'x', decided_at: null, results: [], evidence_hashes: {} };
        return ok({ state: 'verifying', verifier_session_id: id, verification, sessions: [...g.sessions, { id, role: 'verifier', since: 'x' }] });
      }
      if (action === 'verdict') {
        if (session === null || session !== g.verifier_session_id) return forbidden();
        const results = body.results as Array<{ criterion_id: string; result: string }>;
        if (results.map((r) => r.criterion_id).sort().join() !== g.criteria.map((c) => c.id).sort().join()) return err(422, 'goal_invalid', 'One result per criterion.');
        const pass = results.every((r) => r.result === 'pass');
        return ok({
          state: pass ? 'done' : 'active',
          criteria: g.criteria.map((c) => ({ ...c, verified: pass })),
          verification: { ...g.verification!, outcome: pass ? 'pass' : 'fail' },
          verifier_session_id: null,
        });
      }
      if (action === 'handover') {
        if (!isOwner) return forbidden();
        const id = `owner-${++n}`;
        return ok({ owner_session_id: id, sessions: [...g.sessions, { id, role: 'owner', since: 'x' }] });
      }
      return err(500, 'unexpected', `unexpected ${req.method} ${url.pathname}`);
    },
  });
  return Object.assign(fake, {
    writes: () => fake.requests.filter((r) => r.method !== 'GET' && r.path.includes('/goals')),
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  }) as Fake;
}

function box(): { root: string; folder: string; boxFolder: string } {
  const root = mkdtempSync(join(tmpdir(), 'goals-cli-'));
  const folder = join(root, 'drives', 'me', 'Goals', 'eu-billing');
  mkdirSync(join(folder, 'evidence'), { recursive: true });
  writeFileSync(join(folder, 'log.md'), '# Log\n');
  return { root, folder, boxFolder: '/drives/me/Goals/eu-billing' };
}

async function cli(fake: Fake, root: string, sessionId: string | null, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', ...args], {
    env: {
      ...process.env,
      HOME: root,
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_API_URL: fake.url,
      KORTIX_TOKEN: sessionId ? `session:${sessionId}` : 'person',
      KORTIX_PROJECT_ID: 'p1',
      KORTIX_SESSION_ID: sessionId ?? '',
      KORTIX_TURN_MESSAGE_ID: '',
      KORTIX_FEATURE_FLAGS: 'goals,reminders,volumes',
      KORTIX_DRIVES_ROOT: join(root, 'drives'),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out: stdout + stderr, stdout };
}

const brief = (title: string, criteria: string[]) => ['---', `goal_id: ${GOAL_ID}`, `objective: ${title}`, '---', `# ${title}`, '', '## Done criteria', '', ...criteria.map((c) => `- ${c}`), '', '## Context', '', 'In the person words.', ''].join('\n');

test('the real CLI runs a goal end to end through the API: activate, progress, verify, FAIL, verify, PASS → done', async () => {
  const { root, folder, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder));
  fake.sessionMeta.owner = { goal_id: GOAL_ID, goal_role: 'owner' };
  writeFileSync(join(folder, 'GOAL.md'), brief('EU billing live', ['Invoice shows EUR and 19% VAT', 'Checkout charges EUR']));
  try {
    const active = await cli(fake, root, 'owner', ['transition', 'active', '--reason', 'criteria written']);
    expect(active.out).toContain('draft → active');
    expect(active.code).toBe(0);
    const [put, activate] = fake.writes();
    expect(put).toMatchObject({ method: 'PUT', path: `/v1/workspaces/p1/goals/${GOAL_ID}/criteria`, actor: 'session:owner', body: { revision: 1, criteria: ['Invoice shows EUR and 19% VAT', 'Checkout charges EUR'] } });
    expect(activate).toMatchObject({ method: 'POST', path: `/v1/workspaces/p1/goals/${GOAL_ID}/activate`, body: { revision: 2, reason: 'criteria written' } });
    // The mirror after the write: read-only orientation, the brief untouched.
    const md = readFileSync(join(folder, 'GOAL.md'), 'utf8');
    expect(md).toContain('lifecycle_state: active');
    expect(md).toContain('lifecycle_revision: 3');
    expect(md).toContain('## Done criteria');

    // Verification is refused by the API until evidence is reported; the CLI prints its violations.
    const early = await cli(fake, root, 'owner', ['verify']);
    expect(early.code).toBe(1);
    expect(early.out).toContain('Criterion c1 has no evidence.');

    writeFileSync(join(folder, 'evidence', 'a.md'), 'invoice');
    writeFileSync(join(folder, 'evidence', 'b.md'), 'charge');
    const progress = await cli(fake, root, 'owner', ['progress', '--met', 'c1,c2', '--evidence', 'c1=evidence/a.md', '--evidence', 'c2=evidence/b.md', '--summary', 'Both done.']);
    expect(progress.code).toBe(0);
    expect(fake.writes().at(-1)!.body).toEqual({
      revision: 3,
      summary: 'Both done.',
      criteria: [
        { id: 'c1', reported_met: true, evidence: 'evidence/a.md' },
        { id: 'c2', reported_met: true, evidence: 'evidence/b.md' },
      ],
    });
    expect(fake.goal.criteria.every((c) => c.reported_met && !c.verified)).toBe(true);

    expect((await cli(fake, root, 'owner', ['verify'])).code).toBe(0);
    expect(fake.goal.state).toBe('verifying');
    const verifier = fake.goal.verifier_session_id!;

    // The verifier needs its report first, and one result per criterion.
    const noReport = await cli(fake, root, verifier, ['verdict', '--pass', 'c1', '--fail', 'c2', '--note', 'c2=charged in USD']);
    expect(noReport.code).toBe(1);
    expect(noReport.out).toContain('verification.md');
    writeFileSync(join(folder, 'evidence', 'verification.md'), 'c1 PASS: EUR + VAT\nc2 FAIL: charged in USD\n');
    const incomplete = await cli(fake, root, verifier, ['verdict', '--pass', 'c1']);
    expect(incomplete.code).toBe(1);
    expect(incomplete.out).toContain('Criterion c2 has no result');
    expect(fake.writes().filter((w) => w.path.endsWith('/verdict'))).toHaveLength(0);
    // The old pass|fail form is gone.
    expect((await cli(fake, root, verifier, ['verdict', 'pass', '--reason', 'ok'])).out).toContain('is gone');

    const failed = await cli(fake, root, verifier, ['verdict', '--pass', 'c1', '--fail', 'c2', '--note', 'c2=charged in USD']);
    expect(failed.code).toBe(0);
    expect(fake.writes().at(-1)!.body.results).toEqual([
      { criterion_id: 'c1', result: 'pass', note: '' },
      { criterion_id: 'c2', result: 'fail', note: 'charged in USD' },
    ]);
    expect(fake.goal.state).toBe('active');

    // The owner cannot give a verdict on its own goal: the API refuses it and the CLI prints the reason verbatim.
    expect((await cli(fake, root, 'owner', ['verify'])).code).toBe(0);
    const second = fake.goal.verifier_session_id!;
    expect(second).not.toBe(verifier);
    const self = await cli(fake, root, 'owner', ['verdict', '--goal', GOAL_ID, '--pass', 'c1,c2']);
    expect(self.code).toBe(1);
    expect(self.out).toContain('may not verdict this goal');
    const pass = await cli(fake, root, second, ['verdict', '--pass', 'c1,c2', '--json']);
    expect(pass.code).toBe(0);
    expect(JSON.parse(pass.stdout)).toMatchObject({ ok: true, from: 'verifying', to: 'done' });
    expect(fake.goal.criteria.every((c) => c.verified)).toBe(true);
    // The CLI found both verifiers by the API (verifier_session_id), never by a folder.
    expect(fake.requests.some((r) => r.search === `?verifier_session_id=${second}`)).toBe(true);
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('wait sends the question and chase_at; stopped is refused without any request', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 5, criteria: [crit('c1')] }));
  try {
    const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const waited = await cli(fake, root, 'owner', ['transition', 'waiting_on_user', '--reason', 'Which VAT id do we invoice from?', '--chase-at', at]);
    expect(waited.code).toBe(0);
    expect(waited.out).toContain('No turn runs until the assigned user answers');
    expect(fake.writes().at(-1)).toMatchObject({ path: `/v1/workspaces/p1/goals/${GOAL_ID}/wait`, body: { revision: 5, question: 'Which VAT id do we invoice from?', chase_at: at } });
    // Found by owner_session_id: this session has no goal_id metadata.
    expect(fake.requests.some((r) => r.search === '?owner_session_id=owner')).toBe(true);
    // The answer came on the channel: the owner moves the goal back to active itself.
    const back = await cli(fake, root, 'owner', ['transition', 'active', '--reason', 'answered on the channel']);
    expect(back.code).toBe(0);
    expect(fake.requests.some((r) => r.path.endsWith('/activate'))).toBe(true);

    const before = fake.requests.length;
    const stop = await cli(fake, root, 'owner', ['transition', 'stopped', '--reason', 'the user said stop']);
    expect(stop.code).toBe(1);
    expect(stop.out).toContain('Only a person stops a goal, from the Goals page');
    expect(fake.requests.length).toBe(before);
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('409 goal_conflict: re-read once and retry while the move is valid; refuse when it no longer is', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 7, criteria: [crit('c1')] }));
  try {
    // A person renamed the goal meanwhile: progress is still valid, so it retries with the new revision.
    fake.conflictNext = (g) => Object.assign(g, { revision: g.revision + 1, title: 'EU billing (renamed)' });
    const ok = await cli(fake, root, 'owner', ['progress', '--summary', 'Invoices next.']);
    expect(ok.code).toBe(0);
    expect(fake.writes().map((w) => w.body.revision)).toEqual([7, 8]);
    expect(fake.goal.summary).toBe('Invoices next.');

    // A person paused it meanwhile: the move is no longer valid, so nothing is retried.
    fake.conflictNext = (g) => Object.assign(g, { revision: g.revision + 1, paused_at: '2026-11-06T12:00:00Z' });
    const refused = await cli(fake, root, 'owner', ['progress', '--summary', 'More.']);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('A person paused this goal');
    expect(fake.writes()).toHaveLength(3);
    expect(fake.goal.summary).toBe('Invoices next.');
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the mirror is never read back: a forged "done" in GOAL.md changes neither the request nor status', async () => {
  const { root, folder, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 4, criteria: [crit('c1')] }));
  const forged = withLifecycleMirror(brief('EU billing live', ['Invoice shows EUR']), { state: 'done', revision: 99, owner_session_id: 'someone', paused_at: '2026-01-01T00:00:00Z' })
    .replace('---\n# EU', 'state: done\nverified_by: someone\n---\n# EU');
  writeFileSync(join(folder, 'GOAL.md'), forged);
  try {
    expect((await cli(fake, root, 'owner', ['progress', '--met', 'c1', '--evidence', 'c1=evidence/a.md'])).code).toBe(0);
    expect(fake.writes().at(-1)!.body.revision).toBe(4);
    const st = await cli(fake, root, null, ['status', 'eu-billing', '--json']);
    expect(JSON.parse(st.stdout).goal).toMatchObject({ state: 'active', revision: 5 });
    expect(readFileSync(join(folder, 'GOAL.md'), 'utf8')).toContain('lifecycle_revision: 5');
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('handover sends the note; new in a session surfaces the API refusal with the way forward', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 2, criteria: [crit('c1')] }));
  try {
    const out = await cli(fake, root, 'owner', ['handover', '--note', 'Invoices done; checkout next.']);
    expect(out.code).toBe(0);
    expect(fake.writes().at(-1)).toMatchObject({ path: `/v1/workspaces/p1/goals/${GOAL_ID}/handover`, body: { revision: 2, note: 'Invoices done; checkout next.' } });
    expect(fake.goal.owner_session_id).not.toBe('owner');
    // The former owner is no longer the owner: the API refuses its writes.
    const old = await cli(fake, root, 'owner', ['progress', '--goal', GOAL_ID, '--summary', 'x']);
    expect(old.code).toBe(1);
    expect(old.out).toContain('may not progress');

    const created = await cli(fake, root, 'owner', ['new', 'EU billing live']);
    expect(created.code).toBe(1);
    expect(created.out).toContain('A session cannot create a goal.');
    expect(created.out).toContain('from the Goals page');
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/v1/workspaces/p1/goals', body: { brief: 'EU billing live' } });
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('check --enforce: one check per turn id, prompts a draft owner, never an active goal (its wakes are the API\'s)', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder));
  const prompts = () => fake.requests.filter((r) => r.path.endsWith('/prompts'));
  try {
    expect((await cli(fake, root, 'owner', ['check', '--enforce', '--quiet', '--turn', 't1'])).code).toBe(0);
    expect(prompts()).toHaveLength(1);
    expect(String(prompts()[0]!.body.text ?? JSON.stringify(prompts()[0]!.body))).toContain('[GOAL CHECK]');
    // The same turn again: nothing counted, nothing prompted.
    await cli(fake, root, 'owner', ['check', '--enforce', '--quiet', '--turn', 't1']);
    expect(prompts()).toHaveLength(1);

    fake.goal = { ...fake.goal, state: 'active', criteria: [crit('c1')] };
    for (const t of ['t2', 't3', 't4']) await cli(fake, root, 'owner', ['check', '--enforce', '--quiet'], { KORTIX_TURN_MESSAGE_ID: t });
    expect(prompts()).toHaveLength(1);
    // A stalled active goal is reported, not nudged: a nudge would be a turn outside the wake cap.
    const stalled = await cli(fake, root, 'owner', ['check', '--enforce'], { KORTIX_TURN_MESSAGE_ID: 't5' });
    expect(prompts()).toHaveLength(1);
    expect(stalled.out).toContain('Nothing reported for 3 wakes');
    // check never writes the goal or a reminder: the API reconciler repairs the heartbeat.
    expect(fake.writes()).toHaveLength(0);

    // A session that owns nothing: no output, exit 0.
    const other = await cli(fake, root, 'worker', ['check', '--enforce', '--quiet', '--turn', 'x']);
    expect(other).toMatchObject({ code: 0, out: '' });
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ls falls back to the mounted folders, marked as an unverified local copy, when the API does not answer', () => {
  const root = mkdtempSync(join(tmpdir(), 'drives-'));
  const folder = join(root, 'me', 'Goals', 'eu-billing');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'GOAL.md'), brief('EU billing live', ['Invoice shows EUR']).replace('---\n# EU', 'state: done\n---\n# EU'));
  const run = (args: string[]) =>
    Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', ...args], {
      env: { ...process.env, HOME: root, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_API_URL: 'http://127.0.0.1:9/v1', KORTIX_TOKEN: 'person', KORTIX_PROJECT_ID: 'p1', KORTIX_FEATURE_FLAGS: 'goals', KORTIX_DRIVES_ROOT: root },
    });
  const ls = run(['ls', '--json']);
  expect(ls.exitCode).toBe(0);
  const out = JSON.parse(ls.stdout.toString());
  expect(out.source).toBe('unverified_local_copy');
  expect(out.goals).toEqual([{ folder, slug: 'eu-billing', title: 'EU billing live', criteria: ['Invoice shows EUR'], state: 'unknown' }]);
  expect(run(['ls']).stdout.toString()).toContain('Unverified local copy');
  rmSync(root, { recursive: true, force: true });
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
  expect(out(off)).toContain('kortix workspaces features enable goals');
  const on = run(['goals', '--help'], 'volumes,reminders,goals');
  expect(on.exitCode).toBe(0);
  expect(out(on)).toContain('Usage: kortix goals');
});

// ── Characterization: the Goals calls the CLI sends, pinned before they moved onto @kortix/sdk ──

test('409 goal_conflict is re-read and retried once only: a second stale revision is printed, not retried', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 3, criteria: [crit('c1')] }));
  try {
    // A person moved the goal on (bind): the retry carries the revision of the re-read.
    fake.conflictNext = (g) => Object.assign(g, { revision: g.revision + 1 });
    const bound = await cli(fake, root, null, ['bind', 'eu-billing', '--space', 'finance']);
    expect(bound.code).toBe(0);
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['PATCH', `/v1/workspaces/p1/goals/${GOAL_ID}`, { revision: 3, space: 'finance' }],
      ['PATCH', `/v1/workspaces/p1/goals/${GOAL_ID}`, { revision: 4, space: 'finance' }],
    ]);
    expect(bound.out).toContain('is in finance');

    // Every write is stale: one retry, then the API's message, exit 1.
    fake.respond = (r) => (r.method === 'PATCH' ? Response.json({ error: 'goal_conflict', message: 'Still changing.', goal: { ...fake.goal, revision: fake.goal.revision + 1 } }, { status: 409 }) : null);
    const stale = await cli(fake, root, null, ['bind', 'eu-billing', '--clear', '--json']);
    expect(stale.code).toBe(1);
    expect(fake.writes().slice(2).map((w) => w.body)).toEqual([
      { revision: 5, space: null, agent: null },
      { revision: 6, space: null, agent: null },
    ]);
    expect(JSON.parse(stale.stdout)).toEqual({ ok: false, error: 'goal_conflict', message: 'Still changing.', violations: [] });
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('409 goal_conflict: a re-read that makes the move invalid is refused with from/to and no second write', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 2, criteria: [crit('c1', { reported_met: true, evidence: 'evidence/a.md' })] }));
  try {
    fake.conflictNext = (g) => Object.assign(g, { revision: g.revision + 1, state: 'waiting_on_user' });
    const out = await cli(fake, root, 'owner', ['verify', '--json']);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, from: 'waiting_on_user', to: 'verifying', violations: ['The goal is waiting_on_user; verify runs on a goal that is active.'] });
    expect(fake.writes()).toHaveLength(1);
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGoal: no goal_id metadata → ?owner_session_id=<session>, then a fresh GET of that goal; none owned → refused', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 6, criteria: [crit('c1')] }));
  try {
    expect((await cli(fake, root, 'owner', ['progress', '--summary', 'Halfway.'])).code).toBe(0);
    expect(fake.requests.filter((r) => r.path.includes('/goals')).map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([
      'GET /v1/workspaces/p1/goals?owner_session_id=owner',
      `GET /v1/workspaces/p1/goals/${GOAL_ID}`,
      `POST /v1/workspaces/p1/goals/${GOAL_ID}/progress`,
    ]);
    expect(fake.writes().at(-1)).toMatchObject({ body: { revision: 6, summary: 'Halfway.' } });

    const none = await cli(fake, root, 'worker', ['progress', '--summary', 'x']);
    expect(none.code).toBe(1);
    expect(none.out).toContain('This session is the owner of no goal.');
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', search: '?owner_session_id=worker' });
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activate from a draft: PUT …/criteria only when GOAL.md differs; more than 8 criteria are refused before any write', async () => {
  const { root, folder, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { criteria: [crit('c1', { text: 'Invoice shows EUR' })] }));
  try {
    writeFileSync(join(folder, 'GOAL.md'), brief('EU billing live', Array.from({ length: 9 }, (_, i) => `Criterion ${i + 1}`)));
    const tooMany = await cli(fake, root, 'owner', ['transition', 'active', '--reason', 'go']);
    expect(tooMany.code).toBe(1);
    expect(tooMany.out).toContain('GOAL.md lists 9 done criteria; the limit is 8.');
    expect(fake.writes()).toHaveLength(0);

    // The brief differs from the goal: PUT the brief's criteria with the revision read, then activate on the next revision.
    writeFileSync(join(folder, 'GOAL.md'), brief('EU billing live', ['Invoice shows EUR', 'Checkout charges EUR']));
    expect((await cli(fake, root, 'owner', ['transition', 'active', '--reason', 'go'])).code).toBe(0);
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['PUT', `/v1/workspaces/p1/goals/${GOAL_ID}/criteria`, { revision: 1, criteria: ['Invoice shows EUR', 'Checkout charges EUR'] }],
      ['POST', `/v1/workspaces/p1/goals/${GOAL_ID}/activate`, { revision: 2, reason: 'go' }],
    ]);

    // The brief already matches the goal: no criteria write, straight to activate.
    fake.goal = { ...fake.goal, state: 'draft' };
    expect((await cli(fake, root, 'owner', ['transition', 'active', '--reason', 'again'])).code).toBe(0);
    expect(fake.writes().slice(2).map((w) => [w.method, w.path, w.body])).toEqual([['POST', `/v1/workspaces/p1/goals/${GOAL_ID}/activate`, { revision: 3, reason: 'again' }]]);
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a person creates a goal: POST /goals with a new goal_id and the flags as given; verify --json names the verifier', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active', revision: 2, criteria: [crit('c1', { reported_met: true, evidence: 'evidence/a.md' })] }));
  try {
    const created = await cli(fake, root, null, ['new', 'EU', 'billing', 'live', '--criterion', 'Invoice shows EUR', '--agent', 'billing', '--user', 'u1']);
    expect(created.code).toBe(0);
    expect(created.out).toContain('Goal created: ');
    expect(fake.writes()).toEqual([
      {
        method: 'POST',
        path: '/v1/workspaces/p1/goals',
        search: '',
        actor: 'person',
        body: { goal_id: expect.stringMatching(/^[0-9a-f-]{36}$/), brief: 'EU billing live', criteria: ['Invoice shows EUR'], agent: 'billing', assigned_user_id: 'u1' },
      },
    ]);

    const verify = await cli(fake, root, 'owner', ['verify', '--json']);
    expect(verify.code).toBe(0);
    expect(JSON.parse(verify.stdout)).toEqual({ ok: true, from: 'active', to: 'verifying', revision: 3, goal_id: GOAL_ID, verifier_session_id: 'ver-1' });
    const status = await cli(fake, root, null, ['status', 'eu-billing']);
    expect(status.out).toContain('ver-1 (attempt 1, pending)');
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a "." or ".." goal id is refused before any request leaves the CLI', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder, { state: 'active' }));
  try {
    const out = await cli(fake, root, 'owner', ['progress', '--goal', '..', '--summary', 'x']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('".."');
    expect(fake.requests).toEqual([]);
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ls: a 403 feature_disabled is printed with its fix; a 404 falls back to the mounted folders', async () => {
  const { root, boxFolder } = box();
  const fake = fakeApi(goalRecord(boxFolder));
  try {
    fake.respond = () => Response.json({ error: 'Goals is not enabled for this project.', code: 'feature_disabled' }, { status: 403 });
    const off = await cli(fake, root, null, ['ls']);
    expect(off.code).toBe(1);
    expect(off.out).toContain('Goals is not enabled for this project.');
    fake.respond = () => Response.json({ error: 'Not found' }, { status: 404 });
    const gone = await cli(fake, root, null, ['ls', '--json']);
    expect(gone.code).toBe(0);
    expect(JSON.parse(gone.stdout).source).toBe('unverified_local_copy');
  } finally {
    fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
