/**
 * Mid-session refinement sweep — the platform half of the continual-harness
 * loop (see `../refine.ts` for the manifest DSL and the
 * `kortix-harness-refinement` managed skill for the agent-side protocol).
 *
 * Every tick (leader-only, slow cadence — see KORTIX_REFINE_SWEEP_INTERVAL_MS
 * in lib/triggers.ts), the sweep:
 *
 *  1. Enumerates RUNNING sessions grouped by project (sessions-first: only
 *     projects with live sessions can be refined, so no catalog is needed).
 *  2. Reads the project manifest's `refine:` block; skips projects where it
 *     is absent or disabled.
 *  3. Per eligible session, reads the live transcript digest and counts
 *     completed assistant turns past the stored watermark
 *     (`project_sessions.metadata.refine.marker`).
 *  4. When the count reaches `every_turns` (first fire additionally waits
 *     out `warmup_turns`), enqueues a durable continue-session prompt that
 *     tells the agent to run the four-pass refinement protocol and resume
 *     its task. Delivery reuses the trigger scheduler's queue + drain.
 *
 * The fire is idempotent per turn-watermark (`refine:<session>:<marker>`), so
 * a sweep that crashes between enqueue and watermark write cannot double-fire,
 * and per-session fires are hard-capped per UTC day (`max_per_session_per_day`)
 * — caps are a load-bearing safety property of self-refinement, not polish.
 */

import { projectSessions, projects } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { REFINE_EXCLUDED_AGENTS, type RefineSpec, extractRefine } from '../refine';
import { enqueueContinueSessionCommand, resolveProjectAutomationActor } from '../session-lifecycle';
import { readManifest } from '../triggers';
import { withProjectGitAuth } from './git';
import type { ProjectRow, ProjectSessionRow } from './serializers';
import { buildSessionTranscriptDigest } from './session-transcript';

export interface RefineSweepResult {
  projects: number;
  sessions: number;
  fired: number;
  skipped: number;
  failures: number;
}

/** Per-session runtime state, stored under `project_sessions.metadata.refine`. */
export interface RefineSessionState {
  /** ISO `created` of the newest assistant turn counted at the last fire. */
  marker: string | null;
  /** UTC day (`YYYY-MM-DD`) the daily counter belongs to. */
  day: string | null;
  /** Fires on `day`. */
  count: number;
  /** Lifetime fires for this session. */
  total: number;
  last_fired_at: string | null;
}

const EMPTY_STATE: RefineSessionState = {
  marker: null,
  day: null,
  count: 0,
  total: 0,
  last_fired_at: null,
};

export function refineSweepIntervalMs(): number {
  const raw = Number(process.env.KORTIX_REFINE_SWEEP_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

export function refineSweepEnabled(): boolean {
  return process.env.KORTIX_REFINE_SWEEP_ENABLED !== 'false';
}

/** Bound the per-sweep blast radius — each session check is a live sandbox
 *  HTTP read, so a huge fleet drains over successive ticks instead of one. */
function refineSweepSessionLimit(): number {
  const raw = Number(process.env.KORTIX_REFINE_SWEEP_SESSION_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

export function parseRefineSessionState(metadata: unknown): RefineSessionState {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { ...EMPTY_STATE };
  }
  const raw = (metadata as Record<string, unknown>).refine;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...EMPTY_STATE };
  const state = raw as Record<string, unknown>;
  return {
    marker: typeof state.marker === 'string' ? state.marker : null,
    day: typeof state.day === 'string' ? state.day : null,
    count: typeof state.count === 'number' && Number.isFinite(state.count) ? state.count : 0,
    total: typeof state.total === 'number' && Number.isFinite(state.total) ? state.total : 0,
    last_fired_at: typeof state.last_fired_at === 'string' ? state.last_fired_at : null,
  };
}

export interface RefineFireDecision {
  fire: boolean;
  reason: 'due' | 'warmup' | 'below_cadence' | 'daily_cap' | 'no_assistant_turns';
  /** New watermark to persist when firing (ISO `created` of newest turn). */
  marker: string | null;
  /** Assistant turns past the previous watermark. */
  newTurns: number;
}

/**
 * Pure cadence decision — exported for unit tests. `assistantCreated` is the
 * ordered list of `created` ISO timestamps of completed assistant turns in
 * the digest window (oldest → newest, window-capped by the caller).
 */
export function decideRefineFire(input: {
  spec: RefineSpec;
  state: RefineSessionState;
  assistantCreated: string[];
  now: Date;
}): RefineFireDecision {
  const { spec, state, assistantCreated, now } = input;
  const newest = assistantCreated[assistantCreated.length - 1] ?? null;
  if (!newest) return { fire: false, reason: 'no_assistant_turns', marker: null, newTurns: 0 };

  const today = now.toISOString().slice(0, 10);
  if (state.day === today && state.count >= spec.maxPerSessionPerDay) {
    return { fire: false, reason: 'daily_cap', marker: newest, newTurns: 0 };
  }

  const watermark = state.marker;
  if (!watermark) {
    // First fire: wait out the warm-up, then a full cadence window on top —
    // refinement needs a trajectory to read, not a fresh transcript.
    const required = spec.warmupTurns + spec.everyTurns;
    if (assistantCreated.length < required) {
      return { fire: false, reason: 'warmup', marker: newest, newTurns: assistantCreated.length };
    }
    return { fire: true, reason: 'due', marker: newest, newTurns: assistantCreated.length };
  }

  const newTurns = assistantCreated.filter((created) => created > watermark).length;
  if (newTurns < spec.everyTurns) {
    return { fire: false, reason: 'below_cadence', marker: newest, newTurns };
  }
  return { fire: true, reason: 'due', marker: newest, newTurns };
}

export function buildRefinePrompt(input: { spec: RefineSpec; newTurns: number }): string {
  return [
    '[Kortix continual-harness refinement — automated cadence]',
    '',
    `You have completed ~${input.newTurns} turns since the last refinement checkpoint.`,
    'Pause your current task and refine your harness:',
    '',
    '1. Load the `kortix-harness-refinement` skill and follow it exactly.',
    '2. Scan your recent turns for failure signatures (repeated tool failures,',
    '   rediscovery loops, stalled objectives, repeated multi-step patterns,',
    '   exception-raising tools, missed opportunities).',
    '3. Run the four passes over `.kortix/` — prompts, sub-agents, skills/tools,',
    '   memory — editing ONLY components with observed failures. Commit as',
    "   `harness: …` and keep this session's single harness change request",
    '   updated toward main.',
    '4. Resume your task exactly where you left off.',
    '',
    'If the window shows no failure signatures, say so in one line and resume',
    'immediately — a no-op is a valid outcome.',
  ].join('\n');
}

let refineSweepRunning = false;
export let lastRefineSweepAt = 0;

export async function runProjectRefineSweep(now = new Date()): Promise<RefineSweepResult> {
  const result: RefineSweepResult = {
    projects: 0,
    sessions: 0,
    fired: 0,
    skipped: 0,
    failures: 0,
  };
  if (refineSweepRunning) return result;
  refineSweepRunning = true;
  try {
    const running = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.status, 'running'))
      .limit(refineSweepSessionLimit());
    if (running.length === 0) return result;

    const projectIds = [...new Set(running.map((s) => s.projectId))];
    const projectRows = await db
      .select()
      .from(projects)
      .where(and(inArray(projects.projectId, projectIds), eq(projects.status, 'active')));

    for (const project of projectRows) {
      const spec = await loadRefineSpec(project);
      if (!spec || !spec.enabled) continue;
      // Respect the project-level automation kill-switch — a paused project
      // must not receive refinement prompts either.
      const meta = project.metadata as Record<string, unknown> | null;
      if (meta && meta.triggers_paused === true) continue;

      result.projects += 1;
      const actor = await resolveProjectAutomationActor(project.accountId);
      if (!actor) continue;

      const sessions = running.filter(
        (s) =>
          s.projectId === project.projectId &&
          spec.agents.includes(s.agentName) &&
          !REFINE_EXCLUDED_AGENTS.includes(s.agentName) &&
          !isAutomationInternalSession(s.metadata),
      );

      for (const session of sessions) {
        result.sessions += 1;
        try {
          const fired = await refineSessionIfDue({
            project,
            session,
            spec,
            actor,
            now,
          });
          if (fired) result.fired += 1;
          else result.skipped += 1;
        } catch (err) {
          result.failures += 1;
          console.error('[project-refine] session sweep failed', {
            projectId: project.projectId,
            sessionId: session.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return result;
  } finally {
    refineSweepRunning = false;
    lastRefineSweepAt = Date.now();
    if (result.fired || result.failures) {
      console.log('[project-refine] sweep completed', result);
    }
  }
}

async function loadRefineSpec(project: ProjectRow): Promise<RefineSpec | null> {
  let manifest: Awaited<ReturnType<typeof readManifest>>;
  try {
    manifest = await readManifest(await withProjectGitAuth(project));
  } catch {
    return null;
  }
  if (!manifest) return null;
  const { spec, errors } = extractRefine(manifest);
  if (errors.length > 0) {
    console.warn('[project-refine] manifest refine block has errors', {
      projectId: project.projectId,
      errors,
    });
  }
  return spec;
}

/** Sessions minted by platform automation for a bounded job (marketplace
 *  install, onboarding, …) are transient — refining them is noise. */
function isAutomationInternalSession(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false;
  const kind = (metadata as Record<string, unknown>).kind;
  return kind === 'marketplace-install';
}

async function refineSessionIfDue(input: {
  project: ProjectRow;
  session: ProjectSessionRow;
  spec: RefineSpec;
  actor: string;
  now: Date;
}): Promise<boolean> {
  const { project, session, spec, actor, now } = input;
  const state = parseRefineSessionState(session.metadata);

  // Cheap pre-gate before the sandbox read: a session already at its daily cap
  // needs no transcript.
  const today = now.toISOString().slice(0, 10);
  if (state.day === today && state.count >= spec.maxPerSessionPerDay) return false;

  const windowLimit = Math.min(
    400,
    Math.max(3 * spec.everyTurns, spec.warmupTurns + spec.everyTurns + 5),
  );
  const digest = await buildSessionTranscriptDigest({
    session,
    projectId: project.projectId,
    accountId: project.accountId,
    userId: actor,
    limit: windowLimit,
    maxChars: 60,
  });
  if (!digest.available) return false;

  const assistantCreated = digest.messages
    .filter((m) => m.role === 'assistant' && m.completed && m.created)
    .map((m) => m.created as string)
    .sort();

  const decision = decideRefineFire({ spec, state, assistantCreated, now });
  if (!decision.fire || !decision.marker) return false;

  await enqueueContinueSessionCommand({
    source: 'system:refine-cadence',
    projectId: project.projectId,
    accountId: project.accountId,
    sessionId: session.sessionId,
    actorUserId: actor,
    text: buildRefinePrompt({ spec, newTurns: decision.newTurns }),
    // One fire per turn-watermark: a sweep retry (or a crash between enqueue
    // and the metadata write below) re-derives the same key and dedupes.
    idempotencyKey: `refine:${session.sessionId}:${decision.marker}`,
  });

  const nextState: RefineSessionState = {
    marker: decision.marker,
    day: today,
    count: state.day === today ? state.count + 1 : 1,
    total: state.total + 1,
    last_fired_at: now.toISOString(),
  };
  await db
    .update(projectSessions)
    .set({
      metadata: sql`COALESCE(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ refine: nextState })}::jsonb`,
      updatedAt: now,
    })
    .where(eq(projectSessions.sessionId, session.sessionId));

  console.log('[project-refine] refinement prompt queued', {
    projectId: project.projectId,
    sessionId: session.sessionId,
    agent: session.agentName,
    newTurns: decision.newTurns,
    firesToday: nextState.count,
    total: nextState.total,
  });
  return true;
}
