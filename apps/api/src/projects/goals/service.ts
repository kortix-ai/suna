/**
 * Goals: the lifecycle (flag `goals`). Every operation takes a `GoalActor`
 * the route derived from the credential, applies `rules.ts` on the locked row
 * (`store.writeGoal`), then runs its side effects: the heartbeat, sessions,
 * prompts. A side effect that fails leaves the row correct; the reconciler
 * (`reconcile.ts`) brings the heartbeat back in line with it.
 *
 * Wire contract: @kortix/api-contract goals.ts.
 */
import { savedProjectConfig } from '../config-summary/service';
import { loadProjectConfig } from '../git';
import type { ProjectConfigSummary } from '../git/types';
import { withProjectGitAuth } from '../lib/git';
import { createHash, randomUUID } from 'node:crypto';
import {
  GOAL_LIMITS,
  type ActivateGoalRequestSchema,
  type AnswerGoalRequest,
  type CreateGoalRequest,
  type EditGoalRequest,
  type GoalControlRequest,
  type GoalProgressRequestSchema,
  type GoalVerdictRequestSchema,
  type HandoverGoalRequestSchema,
  type RequestVerificationRequestSchema,
  type SetGoalCriteriaRequest,
  type WaitGoalRequestSchema,
} from '@kortix/api-contract';
import type { ProjectGoalCriterion, ProjectGoalVerification } from '@kortix/db';
import type { z } from 'zod';
import { ensurePersonalFolder, ensureProjectDrive, getDrive, type DriveRow } from '../../drives/service';
import { accountMemberRow } from '../../iam/membership-read';
import { logger } from '../../lib/logger';
import { volumeOps } from '../../memory/volume-ops';
import type { ProjectRow } from '../lib/serializers';
import { resolveUserIdentities } from '../lib/user-identity';
import {
  createHeartbeat,
  deleteHeartbeat,
  goalEffects, type GoalEffects,
  readHeartbeat,
  rescheduleHeartbeat,
  sessionExists,
  sessionHealth,
  setHeartbeatEnabled,
} from './effects';
import { notifyGoal } from './notify';
import {
  actorIdOf,
  capabilitiesFor,
  chaseBounds,
  criteriaTextsValid,
  evidencePathError,
  freshCriteria,
  goalSlug,
  goalWakePrompt,
  heartbeatSeconds,
  isGoalManager,
  isOpenState,
  sessionRoles,
  splitBrief,
  verdictViolations,
  verificationReadinessViolations,
  type GoalActor,
} from './rules';
import {
  GoalError,
  getGoal,
  goalFolderTaken,
  goalOfSession,
  installGoalHeartbeat,
  rememberGoalPrompt,
  setGoalSetupKey,
  insertGoal,
  setGoalRuntimeFields,
  writeGoal,
  type GoalEventInput,
  type GoalRow,
} from './store';

export interface GoalContext {
  project: ProjectRow;
  actor: GoalActor;
  /** Tests pin the clock; otherwise every decision reads the database clock. */
  now?: Date;
}

const ev = (actor: GoalActor, kind: string, message: string, data?: Record<string, unknown>, dedupeKey?: string): GoalEventInput => ({
  kind,
  actorKind: actor.kind,
  actorId: actorIdOf(actor),
  message,
  ...(data ? { data } : {}),
  ...(dedupeKey ? { dedupeKey } : {}),
});

/** The row after the side effects (heartbeat id, next wake) a write ran. */
async function reread(goal: GoalRow): Promise<GoalRow> {
  return (await getGoal(goal.projectId, goal.goalId)) ?? goal;
}

// ── Guards ───────────────────────────────────────────────────────────────────

function conflict(goal: GoalRow, message: string): never {
  throw new GoalError(409, 'goal_conflict', message, undefined, goal);
}
function forbidden(message: string): never {
  throw new GoalError(403, 'goal_forbidden', message);
}
function invalid(message: string, violations?: string[]): never {
  throw new GoalError(422, 'goal_invalid', message, violations);
}

function checkRevision(goal: GoalRow, revision: number): void {
  if (goal.revision !== revision) conflict(goal, `The goal changed (revision ${goal.revision}, you sent ${revision}). Read it again.`);
}

function requireManager(goal: GoalRow, actor: GoalActor): void {
  if (actor.kind === 'session') forbidden('A session cannot do this; a person decides it.');
  if (!isGoalManager(goal, actor)) forbidden("Only the goal's creator, its assigned person or a project admin can do this.");
}

/** The caller is the goal's CURRENT owner session, and the goal is not paused or closed (the generation fence). */
function requireOwner(goal: GoalRow, actor: GoalActor): asserts actor is Extract<GoalActor, { kind: 'session' }> {
  if (actor.kind !== 'session') forbidden("Only the goal's owner session can do this.");
  if (goal.ownerSessionId !== actor.sessionId) forbidden("This session is not the goal's current owner.");
  fence(goal);
}

function fence(goal: GoalRow): void {
  if (goal.state === 'stopped') conflict(goal, 'A person stopped this goal. Nothing more runs until they restart it.');
  if (goal.state === 'done') conflict(goal, 'This goal is done.');
  if (goal.pausedAt) conflict(goal, 'A person paused this goal. Finish this turn without changing it.');
}

async function driveOf(goal: GoalRow): Promise<DriveRow> {
  const drive = await getDrive(goal.driveId);
  if (!drive) invalid("The goal's Files drive is gone.");
  return drive;
}

// ── Create ───────────────────────────────────────────────────────────────────

/** The project's agents, to pick one that can work a goal: the saved summary, else the repository (a new project has no summary yet). Null when neither reads. */
export async function goalAgentConfig(row: ProjectRow): Promise<ProjectConfigSummary | null> {
  const saved = await savedProjectConfig(row).catch(() => null);
  if (saved) return saved.config;
  const git = await withProjectGitAuth(row).catch(() => null);
  return git ? loadProjectConfig(git).catch(() => null) : null;
}

function goalFileText(goal: GoalRow): string {
  const criteria = goal.criteria.length
    ? goal.criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n')
    : '<!-- The owner writes 1 to 8 done criteria here as "- " list items, then runs `kortix goals transition active`. -->';
  // JSON string = a valid YAML double-quoted scalar: quotes, backslashes and newlines escaped.
  const objective = JSON.stringify(goal.title);
  return (
    `---\ngoal_id: ${goal.goalId}\nobjective: ${objective}\n---\n\n` +
    `# ${goal.title}\n\n` +
    `<!-- For the agent: the Kortix API holds this goal's state, owner, caps and verification. Editing this file changes the brief only. -->\n\n` +
    (goal.brief ? `## Context\n\n${goal.brief}\n\n` : '') +
    `## Done criteria\n\n${criteria}\n\nCriteria revision ${goal.criteriaRevision}. After activation only a person changes them.\n`
  );
}

function firstPromptText(goal: GoalRow): string {
  const next = goal.criteria.length
    ? 'It is new: check its done criteria, then activate it and start the work.'
    : 'It is new: set 1 to 8 done criteria someone else can check, then activate it and start the work.';
  return `${goalWakePrompt(goal.boxFolder, goal.goalId)} ${next} Its brief is ${goal.boxFolder}/GOAL.md.`;
}

function ownerMetadata(goal: GoalRow, role: 'owner' | 'verifier'): Record<string, unknown> {
  return { unattended: 'true', goal_id: goal.goalId, goal: goal.boxFolder, goal_role: role };
}

async function pickFolder(drive: DriveRow, personal: string, title: string, taken: (folder: string) => Promise<boolean>): Promise<{ slug: string; folder: string }> {
  const base = goalSlug(title);
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const folder = `${personal}/Goals/${slug}`;
    if (await taken(folder)) continue;
    const ops = volumeOps();
    if (ops.available() && (await ops.stat(drive, `${folder}/GOAL.md`).catch(() => null))) continue;
    return { slug, folder };
  }
  return invalid('Too many goals share this name. Reword the first line.');
}

/**
 * `POST /goals`: idempotent on `goal_id`. A retry by the same person finishes
 * the steps a failed attempt left (`setup`); the reconciler does the same.
 */
export async function createGoal(
  ctx: GoalContext,
  input: CreateGoalRequest & { agent: string },
): Promise<GoalRow> {
  const { actor, project } = ctx;
  // A chat session may turn its conversation into a goal for the person it works for ("Make this a goal").
  // A goal's own owner or verifier may not start another goal: no goal spawns goals.
  if (actor.kind === 'platform') forbidden('A person creates a goal.');
  if (actor.kind === 'session' && (await goalOfSession(actor.sessionId))) forbidden("A goal's own session cannot start another goal.");
  const existing = await getGoal(project.projectId, input.goal_id);
  if (existing) {
    if (existing.createdByUserId !== actor.userId) throw new GoalError(409, 'goal_conflict', 'This goal id is taken.');
    return finishGoalSetup(project, existing);
  }
  if (input.criteria?.length) {
    const err = criteriaTextsValid(input.criteria);
    if (err) invalid(err);
  }
  if (input.assigned_user_id && !(await accountMemberRow(project.accountId, input.assigned_user_id))[0]) {
    invalid('The assigned person is not a member of this account.');
  }
  if (!volumeOps().available()) invalid('Files storage is not available on this deployment, so it cannot hold a goal.');
  const drive = await ensureProjectDrive(project.accountId, project.projectId);
  const personal = await ensurePersonalFolder(drive, actor.userId);
  const { title, context } = splitBrief(input.brief);
  // Session ids nobody can predict: a derived id would let another session create it first and be adopted.
  const ownerId = randomUUID();
  const now = ctx.now ?? new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { slug, folder } = await pickFolder(drive, personal, title, (f) => goalFolderTaken(project.projectId, drive.driveId, f));
    const criteria = input.criteria?.length ? freshCriteria(input.criteria) : [];
    const row = await insertGoal(
      {
        goalId: input.goal_id,
        projectId: project.projectId,
        accountId: project.accountId,
        title,
        brief: context.slice(0, GOAL_LIMITS.brief_chars),
        state: 'draft',
        blockedReason: 'setup',
        assignedUserId: input.assigned_user_id ?? null,
        createdByUserId: actor.userId,
        agent: input.agent,
        driveId: drive.driveId,
        folder,
        boxFolder: `/drives/me/Goals/${slug}`,
        slug,
        ownerSessionId: ownerId,
        sessions: [{ id: ownerId, role: 'owner', since: now.toISOString() }],
        criteriaRevision: criteria.length ? 1 : 0,
        criteria,
        setup: {},
      },
      ev(actor, 'created', `Goal created: ${title}`),
    );
    if (row) return finishGoalSetup(project, row);
    const raced = await getGoal(project.projectId, input.goal_id);
    if (raced) return finishGoalSetup(project, raced);
    // Another goal took the folder between the pick and the insert: pick again.
  }
  return invalid('Could not reserve a folder for the goal. Try again.');
}

/** Run every create step not yet done, in order. Each is safe to repeat. Returns the row as it ends. */
export async function finishGoalSetup(project: ProjectRow, goal: GoalRow): Promise<GoalRow> {
  if (goal.blockedReason !== 'setup') return goal;
  const setup = { ...goal.setup };
  const mark = async (step: string) => {
    setup[step] = true;
    await setGoalSetupKey(goal.goalId, step, true);
  };
  const ownerId = goal.ownerSessionId!;
  try {
    if (!setup.session) {
      if (!(await sessionExists(ownerId))) {
        const made = await goalEffects().createSession({
          project,
          userId: goal.createdByUserId,
          sessionId: ownerId,
          agent: goal.agent ?? 'default',
          name: goal.title,
          metadata: ownerMetadata(goal, 'owner'),
        });
        if ('error' in made) {
          logger.warn('[goals] owner session not created', { goal_id: goal.goalId, status: made.status, error: made.error });
          return goal;
        }
      }
      await mark('session');
    }
    if (!setup.heartbeat) {
      if (!goal.heartbeatReminderId) {
        const hb = await createHeartbeat({
          projectId: goal.projectId,
          sessionId: ownerId,
          agent: goal.agent ?? 'default',
          boxFolder: goal.boxFolder,
          goalId: goal.goalId,
          every: goal.heartbeatEvery,
          createdBy: goal.createdByUserId,
          // A draft does not wake on a schedule: activate turns it on.
          enabled: false,
          now: new Date(),
        });
        if ('error' in hb) {
          logger.warn('[goals] heartbeat not created', { goal_id: goal.goalId, error: hb.error });
          return reread(goal);
        }
        // A concurrent setup (a retry, the reconciler) may install first: keep one heartbeat.
        if (!(await installGoalHeartbeat(goal.goalId, null, hb.id, hb.nextFireAt))) await deleteHeartbeat(goal.projectId, hb.id);
      }
      await mark('heartbeat');
    }
    if (!setup.files) {
      const ops = volumeOps();
      if (ops.available()) {
        const drive = await driveOf(goal);
        await ops.write(drive, `${goal.folder}/GOAL.md`, goalFileText(goal), { overwrite: true });
        if (!(await ops.stat(drive, `${goal.folder}/log.md`).catch(() => null))) {
          await ops.write(drive, `${goal.folder}/log.md`, `# Log\n\n- ${goal.createdAt.toISOString()} Goal created: ${goal.title}\n`, { overwrite: true });
        }
      }
      await mark('files');
    }
    if (!setup.prompt) {
      const queued = await goalEffects().queuePrompt({
        project,
        sessionId: ownerId,
        userId: goal.createdByUserId,
        text: firstPromptText(goal),
        key: `goal-start:${goal.goalId}`,
      });
      if (!queued) return goal;
      await mark('prompt');
    }
  } catch (error) {
    logger.warn('[goals] setup step failed', { goal_id: goal.goalId, error: error instanceof Error ? error.message : String(error) });
    return (await getGoal(goal.projectId, goal.goalId)) ?? goal;
  }
  const done = await writeGoal(goal.projectId, goal.goalId, (row) =>
    row.blockedReason === 'setup'
      ? { patch: { blockedReason: null }, event: ev({ kind: 'platform' }, 'setup_finished', 'The owner session, files and heartbeat are ready.') }
      : { unchanged: true },
  );
  return done.row;
}

// ── Person edits ─────────────────────────────────────────────────────────────

export async function editGoal(ctx: GoalContext, goalId: string, req: EditGoalRequest): Promise<GoalRow> {
  if (req.heartbeat_every !== undefined && !heartbeatSeconds(req.heartbeat_every)) {
    invalid(`heartbeat_every must be a duration of at least ${GOAL_LIMITS.heartbeat_min_minutes}m, like 4h.`);
  }
  if (req.assigned_user_id && !(await accountMemberRow(ctx.project.accountId, req.assigned_user_id))[0]) {
    invalid('The assigned person is not a member of this account.');
  }
  const result = await writeGoal(ctx.project.projectId, goalId, (goal) => {
    requireManager(goal, ctx.actor);
    checkRevision(goal, req.revision);
    if (!isOpenState(goal.state)) conflict(goal, 'A closed goal cannot be edited.');
    const patch = {
      ...(req.title !== undefined ? { title: req.title.trim() } : {}),
      ...(req.assigned_user_id !== undefined ? { assignedUserId: req.assigned_user_id } : {}),
      ...(req.space !== undefined ? { space: req.space } : {}),
      ...(req.agent !== undefined ? { agent: req.agent } : {}),
      ...(req.max_wakes_per_day !== undefined ? { maxWakesPerDay: req.max_wakes_per_day } : {}),
      ...(req.max_sessions !== undefined ? { maxSessions: req.max_sessions } : {}),
      ...(req.heartbeat_every !== undefined ? { heartbeatEvery: req.heartbeat_every } : {}),
    };
    // Raising the session cap is what unblocks a session-capped goal.
    const unblock = goal.blockedReason === 'session_cap' && req.max_sessions !== undefined && req.max_sessions > goal.sessions.length;
    return { patch: { ...patch, ...(unblock ? { blockedReason: null } : {}) }, event: ev(ctx.actor, 'edited', 'Goal settings changed.', { fields: Object.keys(patch) }) };
  }, { now: ctx.now });
  if (result.changed && req.heartbeat_every !== undefined && result.before.heartbeatEvery !== req.heartbeat_every) {
    await moveHeartbeat(result.row, result.row.ownerSessionId!, heartbeatWanted(result.row));
  }
  return reread(result.row);
}

export async function setCriteria(ctx: GoalContext, goalId: string, req: SetGoalCriteriaRequest): Promise<GoalRow> {
  const err = criteriaTextsValid(req.criteria);
  if (err) invalid(err);
  const result = await writeGoal(ctx.project.projectId, goalId, (goal) => {
    if (ctx.actor.kind === 'session') {
      requireOwner(goal, ctx.actor);
      if (goal.state !== 'draft') forbidden('The owner sets criteria only while the goal is a draft; after that a person changes them.');
    } else {
      requireManager(goal, ctx.actor);
      if (!isOpenState(goal.state)) conflict(goal, 'A closed goal keeps its criteria.');
    }
    checkRevision(goal, req.revision);
    const stale = goal.state === 'verifying';
    return {
      patch: {
        criteria: freshCriteria(req.criteria),
        criteriaRevision: goal.criteriaRevision + 1,
        // A verification of the old criteria cannot decide the goal any more.
        ...(stale ? { state: 'active' as const, verifierSessionId: null } : {}),
      },
      event: ev(ctx.actor, 'criteria_changed', `Done criteria set (revision ${goal.criteriaRevision + 1}).`, { count: req.criteria.length, stale_verification: stale }),
    };
  }, { now: ctx.now });
  if (result.changed && result.before.state === 'verifying') await applyHeartbeat(result.row);
  return reread(result.row);
}

// ── Owner session ────────────────────────────────────────────────────────────

export async function activateGoal(ctx: GoalContext, goalId: string, req: z.infer<typeof ActivateGoalRequestSchema>): Promise<GoalRow> {
  const result = await writeGoal(ctx.project.projectId, goalId, (goal) => {
    requireOwner(goal, ctx.actor);
    checkRevision(goal, req.revision);
    // waiting_on_user → active: the answer reached the owner another way (a channel reply, email).
    if (goal.state !== 'draft' && goal.state !== 'waiting_on_user') conflict(goal, `Only a draft or a waiting goal activates; this goal is ${goal.state}.`);
    if (goal.criteria.length < GOAL_LIMITS.criteria_min) invalid('Set 1 to 8 done criteria before you activate the goal.');
    return { patch: { state: 'active', waitingOn: null, chaseAt: null }, event: ev(ctx.actor, 'activated', req.reason) };
  }, { now: ctx.now });
  await applyHeartbeat(result.row);
  return reread(result.row);
}

export async function waitGoal(ctx: GoalContext, goalId: string, req: z.infer<typeof WaitGoalRequestSchema>): Promise<GoalRow> {
  const result = await writeGoal(ctx.project.projectId, goalId, (goal, now) => {
    requireOwner(goal, ctx.actor);
    checkRevision(goal, req.revision);
    if (goal.state !== 'active') conflict(goal, `Only an active goal waits; this goal is ${goal.state}.`);
    let chaseAt: Date | null = null;
    if (req.chase_at) {
      const at = new Date(req.chase_at);
      const { min, max } = chaseBounds(now);
      if (Number.isNaN(at.getTime()) || at < min || at > max) {
        invalid(`chase_at must be between ${GOAL_LIMITS.chase_min_minutes} minutes and ${GOAL_LIMITS.chase_max_days} days from now.`);
      }
      chaseAt = at;
    }
    return {
      patch: { state: 'waiting_on_user', waitingOn: req.question, chaseAt },
      event: ev(ctx.actor, 'waiting', req.question, chaseAt ? { chase_at: chaseAt.toISOString() } : undefined),
    };
  }, { now: ctx.now });
  await applyHeartbeat(result.row);
  await notifyGoal(result.row, 'needs_you', req.question, ctx.now ?? new Date());
  return reread(result.row);
}

export async function reportProgress(ctx: GoalContext, goalId: string, req: z.infer<typeof GoalProgressRequestSchema>): Promise<GoalRow> {
  const result = await writeGoal(ctx.project.projectId, goalId, (goal) => {
    requireOwner(goal, ctx.actor);
    checkRevision(goal, req.revision);
    if (goal.state === 'verifying') conflict(goal, 'The goal is being verified; report progress after the verdict.');
    const byId = new Map(goal.criteria.map((c) => [c.id, c]));
    const violations: string[] = [];
    for (const update of req.criteria ?? []) {
      if (!byId.has(update.id)) violations.push(`Criterion ${update.id} is not a criterion of this goal.`);
      if (update.evidence) {
        const e = evidencePathError(update.evidence);
        if (e) violations.push(e);
      }
    }
    if (violations.length) invalid('The progress report was refused.', violations);
    const criteria: ProjectGoalCriterion[] = goal.criteria.map((c) => {
      const update = req.criteria?.find((u) => u.id === c.id);
      if (!update) return c;
      // A report never verifies: `verified` changes only through a verdict.
      return { ...c, reported_met: update.reported_met, evidence: update.evidence === undefined ? c.evidence : update.evidence, verified: false };
    });
    return {
      patch: { criteria, ...(req.summary !== undefined ? { summary: req.summary } : {}) },
      event: ev(ctx.actor, 'progress', req.summary ?? 'Progress reported.', { met: criteria.filter((c) => c.reported_met).map((c) => c.id) }),
    };
  }, { now: ctx.now });
  return reread(result.row);
}

async function evidenceFileViolations(goal: GoalRow): Promise<string[]> {
  const ops = volumeOps();
  if (!ops.available()) return ['Files storage is not available, so the evidence cannot be checked.'];
  const drive = await driveOf(goal);
  const out: string[] = [];
  for (const c of goal.criteria) {
    if (!c.evidence) continue;
    const stat = await ops.stat(drive, `${goal.folder}/${c.evidence}`).catch(() => null);
    if (!stat) out.push(`Evidence ${c.evidence} of criterion ${c.id} does not exist.`);
    else if (stat.type !== 'file') out.push(`Evidence ${c.evidence} of criterion ${c.id} is not a regular file.`);
  }
  return out;
}

export async function requestVerification(ctx: GoalContext, goalId: string, req: z.infer<typeof RequestVerificationRequestSchema>): Promise<GoalRow> {
  const goal = await getGoal(ctx.project.projectId, goalId);
  if (!goal) throw new GoalError(404, 'goal_not_found', 'Goal not found.');
  requireOwner(goal, ctx.actor);
  checkRevision(goal, req.revision);
  if (goal.state !== 'active') conflict(goal, `Only an active goal asks for verification; this goal is ${goal.state}.`);
  const violations = [...verificationReadinessViolations(goal.criteria)];
  if (!violations.length) violations.push(...(await evidenceFileViolations(goal)));
  if (violations.length) invalid('The goal is not ready for verification.', violations);
  if (goal.sessions.length >= goal.maxSessions) await blockSessionCap(goal, ctx);
  const attempt = goal.verificationAttempts + 1;
  // A fresh, unpredictable id per attempt: a derived one would let the owner create the
  // "independent" verifier itself before asking for verification, and be adopted as it.
  const verifierId = randomUUID();
  {
    const made = await goalEffects().createSession({
      project: ctx.project,
      userId: goal.createdByUserId,
      sessionId: verifierId,
      agent: goal.agent ?? 'default',
      name: `Verify: ${goal.title}`,
      metadata: ownerMetadata(goal, 'verifier'),
    });
    if ('error' in made) invalid(`The verifier session could not start: ${made.error}`);
  }
  const result = await writeGoal(ctx.project.projectId, goalId, (row, now) => {
    requireOwner(row, ctx.actor);
    checkRevision(row, req.revision);
    if (row.state !== 'active') conflict(row, `Only an active goal asks for verification; this goal is ${row.state}.`);
    const verification: ProjectGoalVerification = {
      attempt,
      verifier_session_id: verifierId,
      criteria_revision: row.criteriaRevision,
      started_at: now.toISOString(),
      decided_at: null,
      outcome: 'pending',
      results: [],
      evidence_hashes: {},
    };
    return {
      patch: {
        state: 'verifying',
        verifierSessionId: verifierId,
        verification,
        verificationAttempts: attempt,
        sessions: [...row.sessions, { id: verifierId, role: 'verifier', since: now.toISOString() }],
      },
      event: ev(ctx.actor, 'verification_requested', `Verification attempt ${attempt} started.`, { verifier_session_id: verifierId, attempt }),
    };
  }, { now: ctx.now });
  await queueVerifierPrompt(ctx.project, result.row);
  return reread(result.row);
}

/** Queue the verifier's first prompt for the current attempt (remembered and retried when the queue fails). */
export async function queueVerifierPrompt(project: ProjectRow, goal: GoalRow): Promise<boolean> {
  const attempt = goal.verification?.attempt ?? goal.verificationAttempts;
  if (!goal.verifierSessionId) return false;
  return sendGoalPrompt(goal.goalId, {
    project,
    sessionId: goal.verifierSessionId,
    userId: goal.createdByUserId,
    text:
      `You verify goal ${goal.goalId} ("${goal.title}") in ${goal.boxFolder}. You did not do the work. ` +
      'Check every done criterion against its evidence file and against the real world. Write evidence/verification.md, ' +
      'then give the verdict with `kortix goals verdict`: exactly one result (pass, fail or inconclusive) per criterion.',
    key: `goal-verify:${goal.goalId}:${attempt}`,
  });
}

/**
 * Queue a goal prompt. One that does not queue is remembered on the goal and
 * the reconciler queues it under the same key: an answer, a resume or a
 * verifier's first prompt is never lost to a queue outage.
 */
async function sendGoalPrompt(goalId: string, input: Parameters<GoalEffects['queuePrompt']>[0]): Promise<boolean> {
  const queued = await goalEffects().queuePrompt(input);
  if (!queued) await rememberGoalPrompt(goalId, { sessionId: input.sessionId, userId: input.userId, text: input.text, key: input.key });
  return queued;
}

async function blockSessionCap(goal: GoalRow, ctx: GoalContext): Promise<never> {
  const blocked = await writeGoal(goal.projectId, goal.goalId, (row) =>
    row.blockedReason === 'session_cap'
      ? { unchanged: true }
      : { patch: { blockedReason: 'session_cap' }, event: ev({ kind: 'platform' }, 'blocked', `The goal used ${row.sessions.length} of ${row.maxSessions} sessions.`, { reason: 'session_cap' }) },
  );
  await notifyGoal(blocked.row, 'blocked', 'It reached its session cap. Raise the cap to let it continue.', ctx.now ?? new Date());
  return invalid(`The goal has used ${goal.sessions.length} of its ${goal.maxSessions} sessions. A person raises the cap.`);
}

async function evidenceHashes(goal: GoalRow): Promise<Record<string, string>> {
  const ops = volumeOps();
  const out: Record<string, string> = {};
  if (!ops.available()) return out;
  const drive = await driveOf(goal);
  for (const c of goal.criteria) {
    if (!c.evidence || out[c.evidence]) continue;
    const file = await ops.read(drive, `${goal.folder}/${c.evidence}`).catch(() => null);
    if (file) out[c.evidence] = createHash('sha256').update(file.text).digest('hex');
  }
  return out;
}

/** The evidence paths a verdict cannot cover: every criterion's file must read and hash, or `done` is not proven. */
function unhashedEvidence(goal: GoalRow, hashes: Record<string, string>): string[] {
  return [...new Set(goal.criteria.map((c) => c.evidence).filter((p): p is string => !!p && !hashes[p]))];
}

export async function giveVerdict(ctx: GoalContext, goalId: string, req: z.infer<typeof GoalVerdictRequestSchema>): Promise<GoalRow> {
  const before = await getGoal(ctx.project.projectId, goalId);
  if (!before) throw new GoalError(404, 'goal_not_found', 'Goal not found.');
  const hashes = await evidenceHashes(before);
  const result = await writeGoal(ctx.project.projectId, goalId, (goal, now) => {
    const actor = ctx.actor;
    if (actor.kind !== 'session') forbidden("Only the goal's verifier session gives the verdict.");
    if (goal.verifierSessionId !== actor.sessionId) forbidden("This session is not the goal's current verifier.");
    if (sessionRoles(goal, actor.sessionId).has('owner')) forbidden('A session that owned the goal cannot verify it.');
    fence(goal);
    checkRevision(goal, req.revision);
    if (goal.state !== 'verifying') conflict(goal, `The goal is ${goal.state}, not verifying.`);
    if (!goal.verification || goal.verification.criteria_revision !== goal.criteriaRevision) {
      conflict(goal, 'The criteria changed after this verification started; its verdict no longer counts.');
    }
    const violations = verdictViolations(goal.criteria, req.results);
    if (violations.length) invalid('The verdict must give exactly one result for every current criterion.', violations);
    const pass = req.results.every((r) => r.result === 'pass');
    const unread = pass ? unhashedEvidence(goal, hashes) : [];
    if (unread.length) invalid('Every evidence file must be readable for a passing verdict.', unread.map((p) => `Evidence ${p} could not be read.`));
    const verification: ProjectGoalVerification = {
      ...goal.verification,
      decided_at: now.toISOString(),
      outcome: pass ? 'pass' : 'fail',
      results: req.results,
      evidence_hashes: hashes,
    };
    const findings = req.results.filter((r) => r.result !== 'pass').map((r) => `${r.criterion_id} ${r.result}: ${r.note}`).join('; ');
    return {
      patch: pass
        ? { state: 'done', verification, verifierSessionId: null, criteria: goal.criteria.map((c) => ({ ...c, verified: true })), waitingOn: null, chaseAt: null }
        : { state: 'active', verification, verifierSessionId: null, criteria: goal.criteria.map((c) => ({ ...c, verified: false })) },
      event: ev(actor, 'verdict', pass ? 'Every criterion passed an independent check.' : `Verification failed: ${findings}`, { attempt: goal.verification.attempt, outcome: verification.outcome }),
    };
  }, { now: ctx.now });
  const goal = result.row;
  const now = ctx.now ?? new Date();
  if (goal.state === 'done') {
    await dropHeartbeat(goal);
    await notifyGoal(goal, 'verified_done', 'Every criterion passed an independent check.', now);
  } else {
    await applyHeartbeat(goal);
    const attempt = goal.verification?.attempt ?? 0;
    await sendGoalPrompt(goal.goalId, {
      project: ctx.project,
      sessionId: goal.ownerSessionId!,
      userId: goal.createdByUserId,
      text: `${goalWakePrompt(goal.boxFolder, goal.goalId)} Verification attempt ${attempt} failed. Fix what it found, then ask for verification again. ${goalEventLine(goal)}`,
      key: `goal-verdict:${goal.goalId}:${attempt}`,
    });
    await notifyGoal(goal, 'verification_failed', 'An independent check did not pass every criterion.', now);
  }
  return reread(goal);
}

function goalEventLine(goal: GoalRow): string {
  const findings = goal.verification?.results.filter((r) => r.result !== 'pass') ?? [];
  return findings.map((r) => `${r.criterion_id} ${r.result}: ${r.note}`).join(' ').slice(0, 4_000);
}

export async function handoverGoal(ctx: GoalContext, goalId: string, req: z.infer<typeof HandoverGoalRequestSchema>): Promise<GoalRow> {
  const goal = await getGoal(ctx.project.projectId, goalId);
  if (!goal) throw new GoalError(404, 'goal_not_found', 'Goal not found.');
  requireOwner(goal, ctx.actor);
  checkRevision(goal, req.revision);
  if (goal.sessions.length >= goal.maxSessions) await blockSessionCap(goal, ctx);
  const newOwner = randomUUID();
  await ensureOwnerSession(ctx.project, goal, newOwner, ctx.actor.kind === 'session' ? ctx.actor.sessionId : null);
  const result = await writeGoal(ctx.project.projectId, goalId, (row, now) => {
    requireOwner(row, ctx.actor);
    checkRevision(row, req.revision);
    return {
      patch: { ownerSessionId: newOwner, sessions: [...row.sessions, { id: newOwner, role: 'owner', since: now.toISOString() }] },
      bumpGeneration: true,
      event: ev(ctx.actor, 'handover', req.note.slice(0, 500), { from: row.ownerSessionId, to: newOwner }),
    };
  }, { now: ctx.now });
  await moveHeartbeat(result.row, newOwner, heartbeatWanted(result.row));
  await sendGoalPrompt(goal.goalId, {
    project: ctx.project,
    sessionId: newOwner,
    userId: goal.createdByUserId,
    text: `${goalWakePrompt(goal.boxFolder, goal.goalId)} You take over this goal from session ${goal.ownerSessionId}. Its handover note:\n\n${req.note}`,
    key: `goal-handover:${goal.goalId}:${newOwner}`,
  });
  return reread(result.row);
}

async function ensureOwnerSession(project: ProjectRow, goal: GoalRow, sessionId: string, parent: string | null): Promise<void> {
  if (await sessionExists(sessionId)) return;
  const made = await goalEffects().createSession({
    project,
    userId: goal.createdByUserId,
    sessionId,
    agent: goal.agent ?? 'default',
    name: goal.title,
    metadata: ownerMetadata(goal, 'owner'),
    parentSessionId: parent,
  });
  if ('error' in made) invalid(`The new owner session could not start: ${made.error}`);
}

// ── Person controls ──────────────────────────────────────────────────────────

export async function answerGoal(ctx: GoalContext, goalId: string, req: AnswerGoalRequest): Promise<{ goal: GoalRow; deduped: boolean }> {
  const actor = ctx.actor;
  if (actor.kind !== 'user') forbidden('A person answers a goal, not a session.');
  const who = (await resolveUserIdentities([actor.userId])).get(actor.userId);
  const name = who?.displayName?.trim() || who?.email || 'A person';
  const result = await writeGoal(ctx.project.projectId, goalId, (goal) => {
    requireManager(goal, actor);
    if (!isOpenState(goal.state)) conflict(goal, 'A closed goal takes no answers.');
    if (goal.pausedAt) conflict(goal, 'A paused goal takes no answers. Resume it first.');
    if (goal.blockedReason === 'owner_lost') conflict(goal, 'Its owner session is lost. Start the goal again first; then answer.');
    const resumes = goal.state === 'waiting_on_user';
    return {
      patch: resumes ? { state: 'active', waitingOn: null, chaseAt: null } : {},
      event: ev(actor, 'answered', req.text.slice(0, 500), { answer_id: req.answer_id }, `answer:${req.answer_id}`),
    };
  }, { now: ctx.now });
  const goal = result.row;
  // Queued under the answer's key, also on a deduped retry; one that does not queue is
  // remembered and the reconciler delivers it: a recorded answer always reaches the agent.
  const question = result.deduped ? null : result.before.waitingOn;
  await sendGoalPrompt(goal.goalId, {
    project: ctx.project,
    sessionId: goal.ownerSessionId!,
    userId: actor.userId,
    text: `${goalWakePrompt(goal.boxFolder, goal.goalId)} ${name} (user ${actor.userId}) answered${question ? ` your question "${question}"` : ''}:\n\n${req.text}`,
    key: `goal-answer:${goal.goalId}:${req.answer_id}`,
  });
  if (result.deduped) return { goal, deduped: true };
  if (result.before.state === 'waiting_on_user') await applyHeartbeat(goal);
  return { goal: await reread(goal), deduped: false };
}

export async function pauseGoal(ctx: GoalContext, goalId: string, req: GoalControlRequest): Promise<GoalRow> {
  const result = await writeGoal(ctx.project.projectId, goalId, (goal, now) => {
    requireManager(goal, ctx.actor);
    checkRevision(goal, req.revision);
    if (!isOpenState(goal.state)) conflict(goal, 'A closed goal cannot be paused.');
    if (goal.pausedAt) conflict(goal, 'The goal is already paused.');
    return {
      patch: { pausedAt: now, pausedByUserId: actorIdOf(ctx.actor) },
      bumpGeneration: true,
      event: ev(ctx.actor, 'paused', req.reason ?? 'Paused by a person.'),
    };
  }, { now: ctx.now });
  await applyHeartbeat(result.row);
  return reread(result.row);
}

export async function resumeGoal(ctx: GoalContext, goalId: string, req: GoalControlRequest): Promise<GoalRow> {
  const result = await writeGoal(ctx.project.projectId, goalId, (goal) => {
    requireManager(goal, ctx.actor);
    checkRevision(goal, req.revision);
    if (!capabilitiesFor(goal, ctx.actor).resume) conflict(goal, 'The goal is not paused or blocked.');
    const keepBlock = goal.blockedReason === 'wake_cap' || goal.blockedReason === 'setup';
    return {
      patch: { pausedAt: null, pausedByUserId: null, ...(keepBlock ? {} : { blockedReason: null }) },
      event: ev(ctx.actor, 'resumed', req.reason ?? 'Resumed by a person.'),
    };
  }, { now: ctx.now });
  const goal = result.row;
  await applyHeartbeat(goal);
  // A draft wakes too: its owner finishes the criteria and activates (a paused draft has no heartbeat to wake it).
  if (goal.state === 'active' || goal.state === 'verifying' || goal.state === 'draft') {
    const sessionId = goal.state === 'verifying' && goal.verifierSessionId ? goal.verifierSessionId : goal.ownerSessionId!;
    await sendGoalPrompt(goal.goalId, {
      project: ctx.project,
      sessionId,
      userId: goal.createdByUserId,
      text: `${goalWakePrompt(goal.boxFolder, goal.goalId)} A person resumed the goal.`,
      key: `goal-resume:${goal.goalId}:${goal.generation}:${goal.revision}`,
    });
  }
  return reread(goal);
}

/** `POST /stop`. On a goal already stopped it only finishes the cleanup, and answers 200: a retry completes a stop. */
export async function stopGoal(ctx: GoalContext, goalId: string, req: GoalControlRequest): Promise<GoalRow> {
  const result = await writeGoal(ctx.project.projectId, goalId, (goal, now) => {
    requireManager(goal, ctx.actor);
    if (goal.state === 'stopped') return { unchanged: true };
    checkRevision(goal, req.revision);
    if (!isOpenState(goal.state)) conflict(goal, 'A done goal cannot be stopped.');
    return {
      // Prompts that never queued are moot once a person stops the goal; a restart starts fresh.
      patch: { state: 'stopped', stoppedAt: now, stoppedByUserId: actorIdOf(ctx.actor), verifierSessionId: null, setup: { ...goal.setup, pending_prompts: [] } },
      bumpGeneration: true,
      event: ev(ctx.actor, 'stopped', req.reason ?? 'Stopped by a person.'),
    };
  }, { now: ctx.now });
  const goal = result.row;
  await dropHeartbeat(goal);
  if (result.changed) {
    const by = actorIdOf(ctx.actor);
    if (goal.ownerSessionId) await goalEffects().abortTurn(goal.ownerSessionId, by);
    if (result.before.verifierSessionId) await goalEffects().abortTurn(result.before.verifierSessionId, by);
  }
  return reread(goal);
}

export async function restartGoal(ctx: GoalContext, goalId: string, req: GoalControlRequest): Promise<GoalRow> {
  const current = await getGoal(ctx.project.projectId, goalId);
  if (!current) throw new GoalError(404, 'goal_not_found', 'Goal not found.');
  requireManager(current, ctx.actor);
  checkRevision(current, req.revision);
  // A stopped goal, or an open goal whose owner session is lost (owner_lost): a new owner continues where it was.
  const lost = current.blockedReason === 'owner_lost' && isOpenState(current.state);
  if (current.state !== 'stopped' && !lost) conflict(current, 'Only a stopped goal, or one whose owner session is lost, restarts.');
  let owner = current.ownerSessionId;
  if (!owner || (await sessionHealth(owner)) !== 'ok') {
    if (current.sessions.length >= current.maxSessions) await blockSessionCap(current, ctx);
    owner = randomUUID();
    await ensureOwnerSession(ctx.project, current, owner, null);
  }
  const newOwner = owner;
  const result = await writeGoal(ctx.project.projectId, goalId, (goal, now) => {
    requireManager(goal, ctx.actor);
    checkRevision(goal, req.revision);
    const ownerLost = goal.blockedReason === 'owner_lost' && isOpenState(goal.state);
    if (goal.state !== 'stopped' && !ownerLost) conflict(goal, 'Only a stopped goal, or one whose owner session is lost, restarts.');
    const adopted = newOwner !== goal.ownerSessionId;
    return {
      patch: {
        state: ownerLost ? goal.state : goal.criteria.length ? 'active' : 'draft',
        stoppedAt: null,
        stoppedByUserId: null,
        pausedAt: null,
        pausedByUserId: null,
        blockedReason: null,
        waitingOn: null,
        chaseAt: null,
        ...(adopted ? { ownerSessionId: newOwner, sessions: [...goal.sessions, { id: newOwner, role: 'owner' as const, since: now.toISOString() }] } : {}),
      },
      bumpGeneration: true,
      event: ev(ctx.actor, 'restarted', req.reason ?? 'Restarted by a person.', adopted ? { owner_session_id: newOwner } : undefined),
    };
  }, { now: ctx.now });
  const goal = result.row;
  await moveHeartbeat(goal, goal.ownerSessionId!, heartbeatWanted(goal));
  await sendGoalPrompt(goal.goalId, {
    project: ctx.project,
    sessionId: goal.ownerSessionId!,
    userId: goal.createdByUserId,
    text: `${goalWakePrompt(goal.boxFolder, goal.goalId)} A person restarted the goal.${goal.state === 'draft' ? ' Set its done criteria, then activate it.' : ''}`,
    key: `goal-restart:${goal.goalId}:${goal.generation}`,
  });
  return reread(goal);
}

// ── Heartbeat upkeep ─────────────────────────────────────────────────────────

/** Should the heartbeat fire on its schedule now? */
export function heartbeatWanted(goal: GoalRow): boolean {
  // session_cap / owner_lost: a fire could only start a successor the cap or the lost owner forbids.
  if (goal.pausedAt || ['setup', 'flag_off', 'session_cap', 'owner_lost'].includes(goal.blockedReason ?? '')) return false;
  return goal.state === 'active' || goal.state === 'verifying';
}

/** Bring the heartbeat in line with the row: on, off, or set to the chase time. Creates it when missing on an open goal. */
export async function applyHeartbeat(goal: GoalRow): Promise<void> {
  const now = new Date();
  try {
    if (!isOpenState(goal.state)) return dropHeartbeat(goal);
    if (!goal.heartbeatReminderId || !(await readHeartbeat(goal.projectId, goal.heartbeatReminderId))) {
      await moveHeartbeat(goal, goal.ownerSessionId!, heartbeatWanted(goal));
      return;
    }
    if (goal.state === 'waiting_on_user' && goal.chaseAt && !goal.pausedAt) {
      await rescheduleHeartbeat(goal.projectId, goal.heartbeatReminderId, goal.chaseAt, now);
      await setGoalRuntimeFields(goal.goalId, { nextWakeAt: goal.chaseAt });
      return;
    }
    const next = await setHeartbeatEnabled(goal.projectId, goal.heartbeatReminderId, heartbeatWanted(goal), now);
    await setGoalRuntimeFields(goal.goalId, { nextWakeAt: next === false ? null : next });
  } catch (error) {
    logger.warn('[goals] heartbeat update failed; the reconciler repairs it', { goal_id: goal.goalId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * A new heartbeat on `sessionId`, installed by compare-and-set on the id the row
 * held when this started, then the old one deleted. Two concurrent moves both
 * create one; only the first installs, and the other deletes its own, so no
 * enabled reminder is left that the admission gate cannot find.
 */
export async function moveHeartbeat(goal: GoalRow, sessionId: string, enabled: boolean): Promise<void> {
  const previous = (await getGoal(goal.projectId, goal.goalId))?.heartbeatReminderId ?? null;
  const created = await createHeartbeat({
    projectId: goal.projectId,
    sessionId,
    agent: goal.agent ?? 'default',
    boxFolder: goal.boxFolder,
    goalId: goal.goalId,
    every: goal.heartbeatEvery,
    createdBy: goal.createdByUserId,
    enabled,
    now: new Date(),
  });
  if ('error' in created) {
    logger.warn('[goals] heartbeat not created', { goal_id: goal.goalId, error: created.error });
    return;
  }
  if (!(await installGoalHeartbeat(goal.goalId, previous, created.id, created.nextFireAt ?? null))) {
    await deleteHeartbeat(goal.projectId, created.id);
    return;
  }
  if (previous && previous !== created.id) await deleteHeartbeat(goal.projectId, previous);
}

export async function dropHeartbeat(goal: GoalRow): Promise<void> {
  if (!goal.heartbeatReminderId) return;
  await deleteHeartbeat(goal.projectId, goal.heartbeatReminderId);
  await setGoalRuntimeFields(goal.goalId, { heartbeatReminderId: null, nextWakeAt: null });
}

export { randomUUID as newGoalId };
