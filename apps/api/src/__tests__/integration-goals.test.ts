/**
 * Integration test (real local DB, fake Drive volume, sessions and prompts
 * recorded): the goal lifecycle authority (`projects/goals/`, flag `goals`).
 *
 * The trust boundary: a session cannot reach done, stopped or paused; every
 * write is compare-and-set on `revision`; a pause fences the owner; the wake
 * cap counts admitted wakes per UTC day on the database row; a verdict covers
 * exactly the current criteria; a session token cannot touch its goal's
 * heartbeat; a successor session becomes the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectGoalEvents, projectGoals, projectSessions, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { insertIntoView } from './helpers/compat-views';

const { config } = await import('../config');
(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';
const { db } = await import('../shared/db');
const { setVolumeOpsForTests } = await import('../memory/volume-ops');
const { FakeVolume } = await import('./helpers/memory-fake-volume');
const { ensureProjectDrive } = await import('../drives/service');
const { setGoalEffectsForTests } = await import('../projects/goals/effects');
const goals = await import('../projects/goals/service');
const { admitGoalWake, adoptGoalSuccessor, goalHeartbeatEditRefusal, goalPromptRefusal, goalSuccessorAllowed } = await import('../projects/goals/admission');
const { runGoalReconcilerTick } = await import('../projects/goals/reconcile');
const { wakeGoalForMergedChangeRequest } = await import('../projects/lib/goal-wake');
const { fireGitTrigger } = await import('../projects/lib/trigger-fire');
const { GoalError, getGoal } = await import('../projects/goals/store');
const { nextUtcMidnight } = await import('../projects/goals/rules');
type GoalActor = import('../projects/goals/rules').GoalActor;
type ProjectRow = import('../projects/lib/serializers').ProjectRow;

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ANA = crypto.randomUUID();
const BO = crypto.randomUUID();
const volume = new FakeVolume();

const prompts: Array<{ sessionId: string; key: string; text: string; userId: string | null }> = [];
/** Prompt keys whose next queue attempt fails once (a lifecycle queue outage). */
const failPromptOnce = new Set<string>();
const aborted: string[] = [];

let project: ProjectRow;
const ana: GoalActor = { kind: 'user', userId: ANA, isAdmin: false };
const bo: GoalActor = { kind: 'user', userId: BO, isAdmin: false };
const admin: GoalActor = { kind: 'user', userId: BO, isAdmin: true };
const asSession = (sessionId: string): GoalActor => ({ kind: 'session', sessionId, userId: ANA });
const ctx = (actor: GoalActor, now?: Date) => ({ project, actor, ...(now ? { now } : {}) });

async function refusal(run: Promise<unknown>): Promise<{ status: number; code: string; violations?: string[]; revision?: number }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof GoalError) return { status: error.status, code: error.code, violations: error.violations, revision: error.goal?.revision };
    throw error;
  }
  throw new Error('expected a refusal');
}

async function freshGoal(criteria: string[] | undefined = ['The report is published', 'The owner signed off']) {
  const goal = await goals.createGoal(ctx(ana), { goal_id: crypto.randomUUID(), brief: `Publish the synthetic report ${crypto.randomUUID().slice(0, 6)}\nFor the quarterly review.`, criteria, agent: 'kortix' });
  return goal;
}

async function activeGoal() {
  const goal = await freshGoal();
  return goals.activateGoal(ctx(asSession(goal.ownerSessionId!)), goal.goalId, { revision: goal.revision, reason: 'criteria are checkable' });
}

async function heartbeat(goalId: string) {
  const goal = (await getGoal(PROJECT, goalId))!;
  if (!goal.heartbeatReminderId) return null;
  const [row] = await db.select().from(projectTriggerRuntime).where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, goal.heartbeatReminderId)));
  return row ?? null;
}

const eventsOf = (goalId: string) => db.select().from(projectGoalEvents).where(eq(projectGoalEvents.goalId, goalId));

beforeAll(async () => {
  setVolumeOpsForTests(volume);
  for (const [id, name] of [[ANA, 'ana'], [BO, 'bo']] as const) {
    await db.execute(sql`INSERT INTO auth.users (id, email, instance_id, aud, role, raw_user_meta_data) VALUES (${id}::uuid, ${`goals-${name}-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify({ full_name: name === 'ana' ? 'Ana Lima' : 'Bo Chen' })}::jsonb)`);
  }
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'goals-suite' });
  await insertIntoView(db, accountMembers, { userId: ANA, accountId: ACCOUNT, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: BO, accountId: ACCOUNT, accountRole: 'member' });
  [project] = await db
    .insert(projects)
    .values({ projectId: PROJECT, accountId: ACCOUNT, name: 'goals-suite', repoUrl: 'https://example.test/g.git', metadata: { experimental: { goals: true, reminders: true } } })
    .returning();
  await ensureProjectDrive(ACCOUNT, PROJECT);
  setGoalEffectsForTests({
    async createSession(input) {
      await db.insert(projectSessions).values({
        sessionId: input.sessionId,
        accountId: ACCOUNT,
        projectId: PROJECT,
        branchName: input.sessionId,
        createdBy: input.userId,
        agentName: input.agent,
        visibility: 'private',
        metadata: input.metadata,
      }).onConflictDoNothing();
      return { sessionId: input.sessionId };
    },
    async queuePrompt(input) {
      if (failPromptOnce.delete(input.key)) return false;
      if (!prompts.some((p) => p.key === input.key)) prompts.push({ sessionId: input.sessionId, key: input.key, text: input.text, userId: input.userId });
      return true;
    },
    async abortTurn(sessionId) {
      aborted.push(sessionId);
    },
  });
});

afterAll(async () => {
  setVolumeOpsForTests(null);
  setGoalEffectsForTests(null);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${ANA}::uuid, ${BO}::uuid)`);
});

beforeEach(() => {
  prompts.length = 0;
  aborted.length = 0;
});

describe('create', () => {
  test('a person creates a draft goal: idle owner session, GOAL.md, a heartbeat that is off, one first prompt; a retry changes nothing', async () => {
    const goalId = crypto.randomUUID();
    const input = { goal_id: goalId, brief: 'Ship the synthetic launch notes\nKeep it short.', criteria: ['Notes are in Files'], agent: 'kortix' };
    const goal = await goals.createGoal(ctx(ana), input);
    expect(goal.state).toBe('draft');
    expect(goal.blockedReason).toBeNull();
    expect(goal.title).toBe('Ship the synthetic launch notes');
    expect(goal.criteriaRevision).toBe(1);
    expect(goal.folder).toMatch(/^\/Users\/[^/]+\/Goals\/ship-the-synthetic-launch-notes$/);
    expect(goal.boxFolder).toBe('/drives/me/Goals/ship-the-synthetic-launch-notes');
    const [session] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, goal.ownerSessionId!));
    expect(session!.metadata).toMatchObject({ goal_id: goalId, goal_role: 'owner', unattended: 'true', goal: goal.boxFolder });
    expect(volume.files.get(`${goal.folder}/GOAL.md`)?.text).toContain(`goal_id: ${goalId}`);
    expect(volume.files.has(`${goal.folder}/log.md`)).toBe(true);
    const hb = await heartbeat(goalId);
    expect(hb?.enabled).toBe(false);
    expect(hb?.sessionId).toBe(goal.ownerSessionId);
    expect(prompts.map((p) => p.key)).toEqual([`goal-start:${goalId}`]);

    const again = await goals.createGoal(ctx(ana), input);
    expect(again.goalId).toBe(goalId);
    expect(again.revision).toBe(goal.revision);
    expect(prompts.length).toBe(1);
    expect((await db.select().from(projectGoals).where(eq(projectGoals.goalId, goalId))).length).toBe(1);
  });

  test('two goals with the same title get two folders', async () => {
    const a = await goals.createGoal(ctx(ana), { goal_id: crypto.randomUUID(), brief: 'Same synthetic name', agent: 'kortix' });
    const b = await goals.createGoal(ctx(ana), { goal_id: crypto.randomUUID(), brief: 'Same synthetic name', agent: 'kortix' });
    expect(a.folder).not.toBe(b.folder);
    expect(b.slug).toBe('same-synthetic-name-2');
  });

  test("another person cannot reuse a goal id; a goal's own session cannot create another goal", async () => {
    const goal = await freshGoal();
    expect((await refusal(goals.createGoal(ctx(bo), { goal_id: goal.goalId, brief: 'x', agent: 'kortix' }))).status).toBe(409);
    expect((await refusal(goals.createGoal(ctx(asSession(goal.ownerSessionId!)), { goal_id: crypto.randomUUID(), brief: 'x', agent: 'kortix' }))).status).toBe(403);
  });

  test('a chat session ("Make this a goal") creates a goal for the person it works for, with its own owner session', async () => {
    const chat = crypto.randomUUID();
    const made = await goals.createGoal(ctx(asSession(chat)), { goal_id: crypto.randomUUID(), brief: 'Synthetic chat goal\nContext from the chat', agent: 'kortix' });
    expect(made.createdByUserId).toBe(ANA);
    expect(made.ownerSessionId).not.toBe(chat);
    const [created] = await db.select().from(projectGoalEvents).where(and(eq(projectGoalEvents.goalId, made.goalId), eq(projectGoalEvents.kind, 'created')));
    expect(created!.actorKind).toBe('session');
  });
});

describe('forged done is impossible', () => {
  test('the owner session cannot verify, stop, pause, edit or give a verdict; GOAL.md edits change no state', async () => {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    // The agent writes "done" into the file it can edit.
    volume.put(`${goal.folder}/GOAL.md`, '---\nstate: done\nverified_by: someone\n---\n# done\n');
    expect((await getGoal(PROJECT, goal.goalId))!.state).toBe('active');
    for (const run of [
      () => goals.stopGoal(ctx(owner), goal.goalId, { revision: goal.revision }),
      () => goals.pauseGoal(ctx(owner), goal.goalId, { revision: goal.revision }),
      () => goals.editGoal(ctx(owner), goal.goalId, { revision: goal.revision, max_wakes_per_day: 48 }),
      () => goals.giveVerdict(ctx(owner), goal.goalId, { revision: goal.revision, results: [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'pass', note: '' }] }),
      () => goals.setCriteria(ctx(owner), goal.goalId, { revision: goal.revision, criteria: ['easy'] }),
    ]) {
      expect((await refusal(run())).status).toBe(403);
    }
    // Progress reports, never verifies.
    const reported = await goals.reportProgress(ctx(owner), goal.goalId, { revision: goal.revision, criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/report.md' }] });
    expect(reported.criteria[0]).toMatchObject({ reported_met: true, verified: false });
    expect(reported.state).toBe('active');
    // An unrelated member cannot steer it either.
    expect((await refusal(goals.pauseGoal(ctx(bo), goal.goalId, { revision: reported.revision }))).status).toBe(403);
    // A project admin can.
    expect((await goals.pauseGoal(ctx(admin), goal.goalId, { revision: reported.revision })).pausedAt).not.toBeNull();
  });

  test('evidence paths outside evidence/ are refused', async () => {
    const goal = await activeGoal();
    const r = await refusal(goals.reportProgress(ctx(asSession(goal.ownerSessionId!)), goal.goalId, { revision: goal.revision, criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/../GOAL.md' }, { id: 'c9', reported_met: true }] }));
    expect(r.status).toBe(422);
    expect(r.violations!.length).toBe(2);
  });
});

describe('compare-and-set and the generation fence', () => {
  test('a stale revision → 409 goal_conflict carrying the current goal', async () => {
    const goal = await activeGoal();
    const r = await refusal(goals.pauseGoal(ctx(ana), goal.goalId, { revision: goal.revision - 1 }));
    expect(r).toMatchObject({ status: 409, code: 'goal_conflict', revision: goal.revision });
  });

  test('after a pause the owner cannot write, even with the current revision; generation moved', async () => {
    const goal = await activeGoal();
    const paused = await goals.pauseGoal(ctx(ana), goal.goalId, { revision: goal.revision });
    expect(paused.generation).toBe(goal.generation + 1);
    expect((await heartbeat(goal.goalId))!.enabled).toBe(false);
    const r = await refusal(goals.reportProgress(ctx(asSession(goal.ownerSessionId!)), goal.goalId, { revision: paused.revision, summary: 'still working' }));
    expect(r.status).toBe(409);
    const resumed = await goals.resumeGoal(ctx(ana), goal.goalId, { revision: paused.revision });
    expect(resumed.pausedAt).toBeNull();
    expect((await heartbeat(goal.goalId))!.enabled).toBe(true);
    expect(prompts.some((p) => p.key.startsWith(`goal-resume:${goal.goalId}:`))).toBe(true);
  });
});

describe('admission gate', () => {
  test('the wake cap counts admitted wakes per UTC day; the next day starts over', async () => {
    const goal = await activeGoal();
    const capped = await goals.editGoal(ctx(ana), goal.goalId, { revision: goal.revision, max_wakes_per_day: 2 });
    const evening = new Date('2026-11-06T23:00:00.000Z');
    const wake = (key: string, now: Date) => admitGoalWake({ project, goal: capped, idempotencyKey: key, source: 'reminder', now });
    expect((await wake('slot-1', evening)).admitted).toBe(true);
    // The same delivery again: admitted, counted once.
    expect((await wake('slot-1', evening)).admitted).toBe(true);
    expect((await getGoal(PROJECT, goal.goalId))!.wakesToday).toBe(1);
    expect((await wake('slot-2', new Date('2026-11-06T23:30:00.000Z'))).admitted).toBe(true);
    const third = await wake('slot-3', new Date('2026-11-06T23:59:00.000Z'));
    expect(third).toMatchObject({ admitted: false, reason: 'wake_cap' });
    const row = (await getGoal(PROJECT, goal.goalId))!;
    expect(row.blockedReason).toBe('wake_cap');
    expect(row.revision).toBe(capped.revision);
    const hb = await heartbeat(goal.goalId);
    expect(hb!.nextFireAt!.toISOString()).toBe(nextUtcMidnight(new Date('2026-11-06T23:59:00.000Z'), goal.goalId).toISOString());
    expect(hb!.nextFireAt!.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-07T00:00:00.000Z'));
    expect(hb!.nextFireAt!.getTime()).toBeLessThan(Date.parse('2026-11-07T00:15:00.000Z'));
    const morning = await wake('slot-4', new Date('2026-11-07T00:05:00.000Z'));
    expect(morning.admitted).toBe(true);
    const after = (await getGoal(PROJECT, goal.goalId))!;
    expect(after).toMatchObject({ wakeDay: '2026-11-07', wakesToday: 1, blockedReason: null });
    const kinds = (await eventsOf(goal.goalId)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'wake_admitted').length).toBe(3);
    expect(kinds.filter((k) => k === 'wake_refused').length).toBe(1);
  });

  test('a paused, stopped, draft or flag-off goal runs no turn and its heartbeat goes off', async () => {
    const paused = await activeGoal();
    const p = await goals.pauseGoal(ctx(ana), paused.goalId, { revision: paused.revision });
    expect(await admitGoalWake({ project, goal: p, idempotencyKey: 'p-1', source: 'reminder' })).toMatchObject({ admitted: false, reason: 'paused' });

    const stopped = await activeGoal();
    const s = await goals.stopGoal(ctx(ana), stopped.goalId, { revision: stopped.revision });
    expect(await admitGoalWake({ project, goal: s, idempotencyKey: 's-1', source: 'reminder' })).toMatchObject({ admitted: false, reason: 'closed' });

    const draft = await freshGoal();
    expect(await admitGoalWake({ project, goal: draft, idempotencyKey: 'd-1', source: 'reminder' })).toMatchObject({ admitted: false, reason: 'closed' });

    const off = await activeGoal();
    expect((await heartbeat(off.goalId))!.enabled).toBe(true);
    const flagOff = { ...project, metadata: { experimental: { goals: false, reminders: true } } };
    expect(await admitGoalWake({ project: flagOff, goal: off, idempotencyKey: 'f-1', source: 'reminder' })).toMatchObject({ admitted: false, reason: 'flag_off' });
    expect((await getGoal(PROJECT, off.goalId))!.blockedReason).toBe('flag_off');
    expect((await heartbeat(off.goalId))!.enabled).toBe(false);
  });

  test('the reminder fire path asks the gate: a paused goal heartbeat is skipped, no prompt is enqueued', async () => {
    const goal = await activeGoal();
    const paused = await goals.pauseGoal(ctx(ana), goal.goalId, { revision: goal.revision });
    const hb = (await heartbeat(goal.goalId))!;
    const result = await fireGitTrigger({ spec: hb.scheduleSpec as never, project, payload: {}, renderedPrompt: '', source: 'reminder', idempotencyKey: `trigger:cron:${PROJECT}:${hb.slug}:1` });
    expect(result).toMatchObject({ status: 'skipped', reason: 'goal wake refused: paused' });
    const refused = (await eventsOf(paused.goalId)).filter((e) => e.kind === 'wake_refused');
    expect(refused.length).toBe(1);
    expect(refused[0]!.data).toMatchObject({ reason: 'paused', source: 'reminder' });
  });

  test('an event wake resolves the goal by its origin session, carries the reason, and queues once', async () => {
    const goal = await activeGoal();
    const cr = { number: 42, title: 'Synthetic fix', originSessionId: goal.ownerSessionId };
    expect(await wakeGoalForMergedChangeRequest({ project, changeRequest: cr })).toBe('woken');
    expect(await wakeGoalForMergedChangeRequest({ project, changeRequest: cr })).toBe('woken');
    const woken = prompts.filter((p) => p.key === `goal-event:${goal.goalId}:change_request:42`);
    expect(woken.length).toBe(1);
    expect(woken[0]!.sessionId).toBe(goal.ownerSessionId!);
    expect(woken[0]!.text).toContain('Change request #42 "Synthetic fix" merged.');
    expect((await getGoal(PROJECT, goal.goalId))!.wakesToday).toBe(1);
    expect(await wakeGoalForMergedChangeRequest({ project, changeRequest: { ...cr, originSessionId: crypto.randomUUID() } })).toBe('no_goal');
  });
});

describe('verification', () => {
  async function readyGoal() {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    volume.put(`${goal.folder}/evidence/report.md`, 'the report');
    volume.put(`${goal.folder}/evidence/signoff.md`, 'signed');
    const reported = await goals.reportProgress(ctx(owner), goal.goalId, {
      revision: goal.revision,
      criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/report.md' }, { id: 'c2', reported_met: true, evidence: 'evidence/signoff.md' }],
    });
    return { goal: reported, owner };
  }

  test('verification needs every criterion met with an existing evidence file', async () => {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    const reported = await goals.reportProgress(ctx(owner), goal.goalId, { revision: goal.revision, criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/missing.md' }] });
    const r = await refusal(goals.requestVerification(ctx(owner), goal.goalId, { revision: reported.revision }));
    expect(r.status).toBe(422);
    expect(r.violations).toEqual(['Criterion c2 is not reported met.']);
    const both = await goals.reportProgress(ctx(owner), goal.goalId, { revision: reported.revision, criteria: [{ id: 'c2', reported_met: true, evidence: 'evidence/missing-too.md' }] });
    const r2 = await refusal(goals.requestVerification(ctx(owner), goal.goalId, { revision: both.revision }));
    expect(r2.violations!.every((v) => v.includes('does not exist'))).toBe(true);
  });

  test('a verifier prompt that did not queue is retried by the reconciler with the same key', async () => {
    const { goal, owner } = await readyGoal();
    failPromptOnce.add(`goal-verify:${goal.goalId}:1`);
    const verifying = await goals.requestVerification(ctx(owner), goal.goalId, { revision: goal.revision });
    expect(verifying.state).toBe('verifying');
    expect(prompts.some((p) => p.key === `goal-verify:${goal.goalId}:1`)).toBe(false);
    expect(JSON.stringify((await getGoal(PROJECT, goal.goalId))!.setup.pending_prompts)).toContain(`goal-verify:${goal.goalId}:1`);
    let cursor: string | null = null;
    do {
      cursor = (await runGoalReconcilerTick(cursor)).cursor;
    } while (cursor);
    expect(prompts.filter((p) => p.key === `goal-verify:${goal.goalId}:1` && p.sessionId === verifying.verifierSessionId).length).toBe(1);
    expect((await getGoal(PROJECT, goal.goalId))!.setup.pending_prompts).toEqual([]);
  });

  test('a verdict must cover exactly the current criteria; the owner lineage and stale criteria are refused; a full pass is done', async () => {
    const { goal, owner } = await readyGoal();
    const verifying = await goals.requestVerification(ctx(owner), goal.goalId, { revision: goal.revision });
    expect(verifying.state).toBe('verifying');
    const verifier = asSession(verifying.verifierSessionId!);
    expect(prompts.some((p) => p.sessionId === verifying.verifierSessionId && p.key === `goal-verify:${goal.goalId}:1`)).toBe(true);

    const rev = verifying.revision;
    const missing = await refusal(goals.giveVerdict(ctx(verifier), goal.goalId, { revision: rev, results: [{ criterion_id: 'c1', result: 'pass', note: 'ok' }] }));
    expect(missing).toMatchObject({ status: 422, violations: ['Criterion c2 has no result.'] });
    const dup = await refusal(goals.giveVerdict(ctx(verifier), goal.goalId, { revision: rev, results: [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'pass', note: '' }] }));
    expect(dup.violations).toEqual(['Criterion c1 has more than one result.']);
    // The owner, or a session that once owned the goal, cannot verify it.
    expect((await refusal(goals.giveVerdict(ctx(owner), goal.goalId, { revision: rev, results: [] as never }))).status).toBe(403);
    await db.update(projectGoals).set({ sessions: [...verifying.sessions, { id: verifying.verifierSessionId!, role: 'owner', since: new Date().toISOString() }] }).where(eq(projectGoals.goalId, goal.goalId));
    const lineage = await refusal(goals.giveVerdict(ctx(verifier), goal.goalId, { revision: rev, results: [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'pass', note: '' }] }));
    expect(lineage.status).toBe(403);
    await db.update(projectGoals).set({ sessions: verifying.sessions }).where(eq(projectGoals.goalId, goal.goalId));

    const pass = await goals.giveVerdict(ctx(verifier), goal.goalId, { revision: rev, results: [{ criterion_id: 'c1', result: 'pass', note: 'published' }, { criterion_id: 'c2', result: 'pass', note: 'signed' }] });
    expect(pass.state).toBe('done');
    expect(pass.criteria.every((c) => c.verified)).toBe(true);
    expect(pass.verification).toMatchObject({ outcome: 'pass', attempt: 1 });
    expect(Object.keys(pass.verification!.evidence_hashes).sort()).toEqual(['evidence/report.md', 'evidence/signoff.md']);
    expect(pass.heartbeatReminderId).toBeNull();
    expect((await refusal(goals.giveVerdict(ctx(verifier), goal.goalId, { revision: pass.revision, results: [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'pass', note: '' }] }))).status).toBe(403);
  });

  test('criteria a person changes during verification make its verdict stale; a fail goes back to active and wakes the owner', async () => {
    const { goal, owner } = await readyGoal();
    const verifying = await goals.requestVerification(ctx(owner), goal.goalId, { revision: goal.revision });
    const verifierId = verifying.verifierSessionId!;
    const changed = await goals.setCriteria(ctx(ana), goal.goalId, { revision: verifying.revision, criteria: ['The report is published', 'The owner signed off', 'It is translated'] });
    expect(changed).toMatchObject({ state: 'active', criteriaRevision: 2, verifierSessionId: null });
    expect((await refusal(goals.giveVerdict(ctx(asSession(verifierId)), goal.goalId, { revision: changed.revision, results: [{ criterion_id: 'c1', result: 'pass', note: '' }] }))).status).toBe(403);

    const { goal: again, owner: owner2 } = await readyGoal();
    const v2 = await goals.requestVerification(ctx(owner2), again.goalId, { revision: again.revision });
    // A stale verification row on the current verifier: the criteria revision moved under it.
    await db.update(projectGoals).set({ criteriaRevision: 7 }).where(eq(projectGoals.goalId, again.goalId));
    const stale = await refusal(goals.giveVerdict(ctx(asSession(v2.verifierSessionId!)), again.goalId, { revision: v2.revision, results: [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'pass', note: '' }] }));
    expect(stale.status).toBe(409);
    await db.update(projectGoals).set({ criteriaRevision: v2.criteriaRevision }).where(eq(projectGoals.goalId, again.goalId));
    const fail = await goals.giveVerdict(ctx(asSession(v2.verifierSessionId!)), again.goalId, { revision: v2.revision, results: [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'fail', note: 'no signature in the file' }] });
    expect(fail.state).toBe('active');
    expect(fail.criteria.some((c) => c.verified)).toBe(false);
    expect((await heartbeat(again.goalId))!.enabled).toBe(true);
    const wake = prompts.find((p) => p.key === `goal-verdict:${again.goalId}:1`);
    expect(wake?.sessionId).toBe(again.ownerSessionId!);
    expect(wake?.text).toContain('no signature in the file');
  });
});

describe('people', () => {
  test('an answer is idempotent on answer_id, names the person, and moves waiting → active', async () => {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    const waiting = await goals.waitGoal(ctx(owner), goal.goalId, { revision: goal.revision, question: 'Which region?' });
    expect(waiting.state).toBe('waiting_on_user');
    expect((await heartbeat(goal.goalId))!.enabled).toBe(false);
    const answerId = crypto.randomUUID();
    const first = await goals.answerGoal(ctx(ana), goal.goalId, { answer_id: answerId, text: 'EU only' });
    expect(first).toMatchObject({ deduped: false });
    expect(first.goal.state).toBe('active');
    const second = await goals.answerGoal(ctx(ana), goal.goalId, { answer_id: answerId, text: 'EU only' });
    expect(second.deduped).toBe(true);
    expect(second.goal.revision).toBe(first.goal.revision);
    const sent = prompts.filter((p) => p.key === `goal-answer:${goal.goalId}:${answerId}`);
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toContain(`(user ${ANA}) answered your question "Which region?"`);
    expect(sent[0]!.userId).toBe(ANA);
    expect((await heartbeat(goal.goalId))!.enabled).toBe(true);
    expect((await refusal(goals.answerGoal(ctx(bo), goal.goalId, { answer_id: crypto.randomUUID(), text: 'x' }))).status).toBe(403);
  });

  test('the owner moves a waiting goal back to active when the answer came another way; a paused one it cannot', async () => {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    const waiting = await goals.waitGoal(ctx(owner), goal.goalId, { revision: goal.revision, question: 'Which region?' });
    const back = await goals.activateGoal(ctx(owner), goal.goalId, { revision: waiting.revision, reason: 'They answered on the channel: EU' });
    expect(back.state).toBe('active');
    expect(back.waitingOn).toBeNull();
    expect((await heartbeat(goal.goalId))!.enabled).toBe(true);
    const again = await goals.waitGoal(ctx(owner), goal.goalId, { revision: back.revision, question: 'Which currency?' });
    const paused = await goals.pauseGoal(ctx(ana), goal.goalId, { revision: again.revision });
    expect((await refusal(goals.activateGoal(ctx(owner), goal.goalId, { revision: paused.revision, reason: 'x' }))).status).toBe(409);
  });

  test('a stop retry on a stopped goal finishes the cleanup and answers with the goal', async () => {
    const goal = await activeGoal();
    const stopped = await goals.stopGoal(ctx(ana), goal.goalId, { revision: goal.revision });
    expect(stopped.state).toBe('stopped');
    expect(stopped.heartbeatReminderId).toBeNull();
    expect(aborted).toContain(goal.ownerSessionId!);
    // A heartbeat the first stop did not delete (a crash between the steps).
    await goals.moveHeartbeat(stopped, stopped.ownerSessionId!, true);
    expect((await getGoal(PROJECT, goal.goalId))!.heartbeatReminderId).not.toBeNull();
    const retried = await goals.stopGoal(ctx(ana), goal.goalId, { revision: 1 });
    expect(retried.state).toBe('stopped');
    expect(retried.revision).toBe(stopped.revision);
    expect((await getGoal(PROJECT, goal.goalId))!.heartbeatReminderId).toBeNull();
    const restarted = await goals.restartGoal(ctx(ana), goal.goalId, { revision: stopped.revision });
    expect(restarted.state).toBe('active');
    expect((await heartbeat(goal.goalId))!.enabled).toBe(true);
  });
});

describe('the heartbeat belongs to the API', () => {
  test('a session credential may not edit a goal heartbeat; a person and other loops are not refused', async () => {
    const goal = await activeGoal();
    expect(await goalHeartbeatEditRefusal(PROJECT, goal.heartbeatReminderId!, true)).toContain(goal.goalId);
    expect(await goalHeartbeatEditRefusal(PROJECT, goal.heartbeatReminderId!, false)).toBeNull();
    expect(await goalHeartbeatEditRefusal(PROJECT, 'reminder.000000000000', true)).toBeNull();
  });

  test('two concurrent heartbeat moves leave exactly one reminder, the one the goal names', async () => {
    const goal = await activeGoal();
    const { moveHeartbeat } = await import('../projects/goals/service');
    await Promise.all([moveHeartbeat(goal, goal.ownerSessionId!, true), moveHeartbeat(goal, goal.ownerSessionId!, true)]);
    const rows = await db.select().from(projectTriggerRuntime).where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.sessionId, goal.ownerSessionId!)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.slug).toBe((await getGoal(PROJECT, goal.goalId))!.heartbeatReminderId!);
  });

  test('a successor session takes over the heartbeat and becomes the owner; at the session cap no successor starts', async () => {
    const goal = await activeGoal();
    const successor = crypto.randomUUID();
    const adopted = await adoptGoalSuccessor(PROJECT, goal.heartbeatReminderId!, successor);
    expect(adopted).toMatchObject({ ownerSessionId: successor, generation: goal.generation + 1 });
    expect(adopted!.sessions.map((s) => s.id)).toEqual([goal.ownerSessionId!, successor]);
    expect(await adoptGoalSuccessor(PROJECT, goal.heartbeatReminderId!, successor)).toMatchObject({ generation: goal.generation + 1 });
    expect((await eventsOf(goal.goalId)).filter((e) => e.kind === 'owner_adopted').length).toBe(1);
    // The old owner is fenced out.
    expect((await refusal(goals.reportProgress(ctx(asSession(goal.ownerSessionId!)), goal.goalId, { revision: adopted!.revision, summary: 'x' }))).status).toBe(403);

    await db.update(projectGoals).set({ maxSessions: 2 }).where(eq(projectGoals.goalId, goal.goalId));
    const verdict = await goalSuccessorAllowed(PROJECT, goal.heartbeatReminderId!);
    expect(verdict.allowed).toBe(false);
    expect(verdict.goal!.blockedReason).toBe('session_cap');
  });
});

describe('council round 1 fixes', () => {
  test('a goal prompt queued before a pause or stop is refused at delivery; after resume it runs', async () => {
    const goal = await activeGoal();
    expect(await goalPromptRefusal(goal.ownerSessionId!)).toBeNull();
    const paused = await goals.pauseGoal(ctx(ana), goal.goalId, { revision: goal.revision });
    expect(await goalPromptRefusal(goal.ownerSessionId!)).toContain('paused');
    const resumed = await goals.resumeGoal(ctx(ana), goal.goalId, { revision: paused.revision });
    expect(await goalPromptRefusal(goal.ownerSessionId!)).toBeNull();
    await goals.stopGoal(ctx(ana), goal.goalId, { revision: resumed.revision });
    expect(await goalPromptRefusal(goal.ownerSessionId!)).toContain('stopped');
  });

  test('an answer whose prompt did not queue is kept and delivered once by the reconciler; a retry does not duplicate it', async () => {
    const goal = await activeGoal();
    const answerId = crypto.randomUUID();
    failPromptOnce.add(`goal-answer:${goal.goalId}:${answerId}`);
    const first = await goals.answerGoal(ctx(ana), goal.goalId, { answer_id: answerId, text: 'EU only' });
    expect(first.deduped).toBe(false);
    expect(prompts.some((p) => p.key === `goal-answer:${goal.goalId}:${answerId}`)).toBe(false);
    let cursor: string | null = null;
    do {
      cursor = (await runGoalReconcilerTick(cursor)).cursor;
    } while (cursor);
    await goals.answerGoal(ctx(ana), goal.goalId, { answer_id: answerId, text: 'EU only' });
    expect(prompts.filter((p) => p.key === `goal-answer:${goal.goalId}:${answerId}`).length).toBe(1);
    expect((await getGoal(PROJECT, goal.goalId))!.setup.pending_prompts).toEqual([]);
  });

  test('a remembered answer goes to the current owner after a handover; a stop clears remembered prompts', async () => {
    const goal = await activeGoal();
    const answerId = crypto.randomUUID();
    failPromptOnce.add(`goal-answer:${goal.goalId}:${answerId}`);
    const answered = await goals.answerGoal(ctx(ana), goal.goalId, { answer_id: answerId, text: 'EU only' });
    const handed = await goals.handoverGoal(ctx(asSession(goal.ownerSessionId!)), goal.goalId, { revision: answered.goal.revision, note: 'context full' });
    expect(handed.ownerSessionId).not.toBe(goal.ownerSessionId);
    let cursor: string | null = null;
    do {
      cursor = (await runGoalReconcilerTick(cursor)).cursor;
    } while (cursor);
    const sent = prompts.filter((p) => p.key === `goal-answer:${goal.goalId}:${answerId}`);
    expect(sent.map((p) => p.sessionId)).toEqual([handed.ownerSessionId!]);

    const again = crypto.randomUUID();
    failPromptOnce.add(`goal-answer:${goal.goalId}:${again}`);
    const a2 = await goals.answerGoal(ctx(ana), goal.goalId, { answer_id: again, text: 'and GBP' });
    await goals.stopGoal(ctx(ana), goal.goalId, { revision: a2.goal.revision });
    expect((await getGoal(PROJECT, goal.goalId))!.setup.pending_prompts).toEqual([]);
  });

  test('the verifier is a fresh session the engine creates: a session made earlier under any id is never adopted', async () => {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    volume.put(`${goal.folder}/evidence/a.md`, 'a');
    volume.put(`${goal.folder}/evidence/b.md`, 'b');
    const reported = await goals.reportProgress(ctx(owner), goal.goalId, { revision: goal.revision, criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/a.md' }, { id: 'c2', reported_met: true, evidence: 'evidence/b.md' }] });
    const before = new Set((await db.select({ id: projectSessions.sessionId }).from(projectSessions).where(eq(projectSessions.projectId, PROJECT))).map((r) => r.id));
    const verifying = await goals.requestVerification(ctx(owner), goal.goalId, { revision: reported.revision });
    expect(before.has(verifying.verifierSessionId!)).toBe(false);
    const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, verifying.verifierSessionId!));
    expect((row!.metadata as Record<string, unknown>).goal_role).toBe('verifier');
  });

  test('a queued goal prompt is refused while the project goals flag is off', async () => {
    const goal = await activeGoal();
    expect(await goalPromptRefusal(goal.ownerSessionId!)).toBeNull();
    await db.update(projects).set({ metadata: { experimental: { goals: false, reminders: true } } }).where(eq(projects.projectId, PROJECT));
    try {
      expect(await goalPromptRefusal(goal.ownerSessionId!)).toContain('turned off');
    } finally {
      await db.update(projects).set({ metadata: { experimental: { goals: true, reminders: true } } }).where(eq(projects.projectId, PROJECT));
    }
  });

  test("a verifier's queued prompt is refused after a stop (the stop cleared the verifier)", async () => {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    volume.put(`${goal.folder}/evidence/a.md`, 'a');
    volume.put(`${goal.folder}/evidence/b.md`, 'b');
    const reported = await goals.reportProgress(ctx(owner), goal.goalId, { revision: goal.revision, criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/a.md' }, { id: 'c2', reported_met: true, evidence: 'evidence/b.md' }] });
    const verifying = await goals.requestVerification(ctx(owner), goal.goalId, { revision: reported.revision });
    const verifierId = verifying.verifierSessionId!;
    expect(await goalPromptRefusal(verifierId)).toBeNull();
    await goals.stopGoal(ctx(ana), goal.goalId, { revision: verifying.revision });
    expect(await goalPromptRefusal(verifierId)).toContain('stopped');
  });

  test('resuming a paused draft wakes its owner (a draft has no heartbeat)', async () => {
    const goal = await freshGoal();
    const paused = await goals.pauseGoal(ctx(ana), goal.goalId, { revision: goal.revision });
    prompts.length = 0;
    await goals.resumeGoal(ctx(ana), goal.goalId, { revision: paused.revision });
    expect(prompts.some((p) => p.sessionId === goal.ownerSessionId && p.key.startsWith(`goal-resume:${goal.goalId}:`))).toBe(true);
  });

  test('a passing verdict needs every evidence file readable', async () => {
    const goal = await activeGoal();
    const owner = asSession(goal.ownerSessionId!);
    volume.put(`${goal.folder}/evidence/a.md`, 'a');
    volume.put(`${goal.folder}/evidence/b.md`, 'b');
    const reported = await goals.reportProgress(ctx(owner), goal.goalId, { revision: goal.revision, criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/a.md' }, { id: 'c2', reported_met: true, evidence: 'evidence/b.md' }] });
    const verifying = await goals.requestVerification(ctx(owner), goal.goalId, { revision: reported.revision });
    (volume as unknown as { files: Map<string, unknown> }).files.delete(`${goal.folder}/evidence/b.md`);
    const r = await refusal(goals.giveVerdict(ctx(asSession(verifying.verifierSessionId!)), goal.goalId, { revision: verifying.revision, results: [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'pass', note: '' }] }));
    expect(r.status).toBe(422);
    expect(r.violations).toEqual(['Evidence evidence/b.md could not be read.']);
    expect((await getGoal(PROJECT, goal.goalId))!.state).toBe('verifying');
  });

  test('a failed owner at the session cap becomes owner_lost in one tick, heartbeat off; answers are refused until a restart', async () => {
    const goal = await activeGoal();
    await db.update(projectGoals).set({ blockedReason: 'session_cap' }).where(eq(projectGoals.goalId, goal.goalId));
    await db.update(projectSessions).set({ status: 'failed' }).where(eq(projectSessions.sessionId, goal.ownerSessionId!));
    let cursor: string | null = null;
    do {
      cursor = (await runGoalReconcilerTick(cursor)).cursor;
    } while (cursor);
    const lost = (await getGoal(PROJECT, goal.goalId))!;
    expect(lost.blockedReason).toBe('owner_lost');
    expect((await heartbeat(goal.goalId))?.enabled ?? false).toBe(false);
    expect((await eventsOf(goal.goalId)).filter((e) => e.kind === 'repaired').length).toBe(0);
    expect((await refusal(goals.answerGoal(ctx(ana), goal.goalId, { answer_id: crypto.randomUUID(), text: 'x' }))).status).toBe(409);
  });
});

describe('reconciler', () => {
  test('finishes a create left in setup and repairs a missing heartbeat', async () => {
    const goal = await activeGoal();
    await db.delete(projectTriggerRuntime).where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, goal.heartbeatReminderId!)));
    const partial = await freshGoal();
    await db.update(projectGoals).set({ blockedReason: 'setup', setup: { session: true, files: true, heartbeat: true }, createdAt: new Date(Date.now() - 60_000) }).where(eq(projectGoals.goalId, partial.goalId));
    prompts.length = 0;
    let cursor: string | null = null;
    do {
      cursor = (await runGoalReconcilerTick(cursor)).cursor;
    } while (cursor);
    expect((await heartbeat(goal.goalId))?.enabled).toBe(true);
    expect((await eventsOf(goal.goalId)).some((e) => e.kind === 'repaired')).toBe(true);
    expect((await getGoal(PROJECT, partial.goalId))!.blockedReason).toBeNull();
    expect(prompts.filter((p) => p.key === `goal-start:${partial.goalId}`).length).toBe(1);
  });

  test('a draft whose owner session failed is blocked owner_lost (nothing would wake a successor); a person restarts it with a new owner', async () => {
    const goal = await freshGoal();
    await db.update(projectSessions).set({ status: 'failed' }).where(eq(projectSessions.sessionId, goal.ownerSessionId!));
    let cursor: string | null = null;
    do {
      cursor = (await runGoalReconcilerTick(cursor)).cursor;
    } while (cursor);
    const blocked = (await getGoal(PROJECT, goal.goalId))!;
    expect(blocked.blockedReason).toBe('owner_lost');
    expect(blocked.state).toBe('draft');
    // The one way out is Restart: no Pause, no Resume next to it.
    const { capabilitiesFor } = await import('../projects/goals/rules');
    expect(capabilitiesFor(blocked, ana)).toMatchObject({ restart: true, resume: false, pause: false, stop: true });
    prompts.length = 0;
    const restarted = await goals.restartGoal(ctx(ana), goal.goalId, { revision: blocked.revision });
    expect(restarted.state).toBe('draft');
    expect(restarted.blockedReason).toBeNull();
    expect(restarted.ownerSessionId).not.toBe(goal.ownerSessionId);
    expect(restarted.sessions.filter((x) => x.role === 'owner').length).toBe(2);
    expect(prompts.some((p) => p.sessionId === restarted.ownerSessionId)).toBe(true);
  });
});
