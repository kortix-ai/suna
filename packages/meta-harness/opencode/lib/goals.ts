import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Goals: the durable state of a long-running objective, and the pure rules the
// goal loop applies to it.
//
// A goal belongs to one OpenCode session (the Kortix Agent conversation that
// owns it). State lives in ONE JSON file outside the workspace, so it survives
// compaction, restarts and sandbox stop/resume, and never dirties a repo.
//
// No I/O in the rules below except the two file helpers; the plugin
// (../plugin/kortix-goals.ts) supplies the clock and the transport.
// ─────────────────────────────────────────────────────────────────────────────

export const GOAL_STATUSES = [
  'active',
  'waiting',
  'paused',
  'blocked',
  'limited',
  'complete',
  'cancelled',
] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

export const TASK_STATUSES = ['todo', 'doing', 'done', 'failed', 'dropped'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface GoalTask {
  id: string
  title: string
  status: TaskStatus
  session_id: string | null
  evidence: string | null
}

export interface Goal {
  id: string
  /** The OpenCode session that owns and drives the goal. */
  session_id: string
  title: string
  objective: string
  acceptance: string[]
  status: GoalStatus
  status_reason: string | null
  evidence: string[]
  tasks: GoalTask[]
  created_at: string
  updated_at: string
  /** The agent's self-scheduled next check. */
  next_wake_at: string | null
  continuations: number
  max_continuations: number
  no_progress_streak: number
  empty_turn_streak: number
  fingerprint: string | null
}

export interface GoalFile {
  version: 1
  goals: Goal[]
}

export const DEFAULT_MAX_CONTINUATIONS = 200
export const EMPTY_TURN_LIMIT = 3
export const REPLAN_AFTER = 3
export const BLOCK_AFTER = 8

export function goalFilePath(env: Record<string, string | undefined> = process.env): string {
  const override = env.KORTIX_GOALS_FILE?.trim()
  if (override) return override
  return join(homedir(), '.local', 'share', 'kortix', 'goals.json')
}

export function emptyGoalFile(): GoalFile {
  return { version: 1, goals: [] }
}

export function readGoalFile(path: string): GoalFile {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<GoalFile>
    return { version: 1, goals: Array.isArray(data.goals) ? (data.goals as Goal[]) : [] }
  } catch {
    return emptyGoalFile()
  }
}

/** Temp file + rename: a reader never sees a torn file. */
export function writeGoalFile(path: string, file: GoalFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

// ── mutations the tools perform ─────────────────────────────────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

function shortId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`
}

export function createGoal(
  file: GoalFile,
  input: {
    sessionId: string
    title: string
    objective: string
    acceptance: string[]
    maxContinuations?: number
    now: Date
  },
): Result<Goal> {
  const objective = input.objective.trim()
  if (!objective) return { ok: false, error: 'objective is empty' }
  const stamp = input.now.toISOString()
  const goal: Goal = {
    id: shortId('g_'),
    session_id: input.sessionId,
    title: input.title.trim() || objective.slice(0, 80),
    objective,
    acceptance: input.acceptance.map((a) => a.trim()).filter(Boolean),
    status: 'active',
    status_reason: null,
    evidence: [],
    tasks: [],
    created_at: stamp,
    updated_at: stamp,
    next_wake_at: null,
    continuations: 0,
    max_continuations: input.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
    no_progress_streak: 0,
    empty_turn_streak: 0,
    fingerprint: null,
  }
  file.goals.push(goal)
  return { ok: true, value: goal }
}

export function findGoal(file: GoalFile, sessionId: string, goalId: string): Result<Goal> {
  const goal = file.goals.find((g) => g.id === goalId && g.session_id === sessionId)
  return goal ? { ok: true, value: goal } : { ok: false, error: `no goal ${goalId} in this session` }
}

/**
 * Status changes the agent may make. `complete` needs evidence for every
 * acceptance criterion; `waiting` needs the question the user must answer.
 * Resuming a goal the user stopped is allowed: the agent does it when the user
 * asks it to continue.
 */
export function setGoalStatus(
  goal: Goal,
  input: { status: GoalStatus; evidence?: string[]; reason?: string; now: Date },
): Result<Goal> {
  if (goal.status === 'cancelled') return { ok: false, error: 'a cancelled goal cannot change' }
  if (input.status === 'limited') return { ok: false, error: 'only the harness sets limited' }
  if (input.status === 'complete') {
    const evidence = (input.evidence ?? []).map((e) => e.trim())
    const required = Math.max(1, goal.acceptance.length)
    if (evidence.length < required || evidence.some((e) => !e)) {
      return {
        ok: false,
        error:
          goal.acceptance.length === 0
            ? 'give one evidence item: what was done and how you verified it'
            : `give one evidence item per acceptance criterion (${goal.acceptance.length} required, ${evidence.filter(Boolean).length} given)`,
      }
    }
    goal.evidence = evidence
  }
  if ((input.status === 'waiting' || input.status === 'blocked') && !input.reason?.trim()) {
    return { ok: false, error: `a ${input.status} goal needs a reason: the question or the blocker` }
  }
  goal.status = input.status
  goal.status_reason = input.reason?.trim() || null
  goal.updated_at = input.now.toISOString()
  if (input.status === 'active') {
    goal.no_progress_streak = 0
    goal.empty_turn_streak = 0
    if (goal.continuations >= goal.max_continuations) goal.max_continuations += DEFAULT_MAX_CONTINUATIONS
  }
  return { ok: true, value: goal }
}

export function addTask(goal: Goal, input: { title: string; now: Date }): Result<GoalTask> {
  const title = input.title.trim()
  if (!title) return { ok: false, error: 'task title is empty' }
  const task: GoalTask = {
    id: `t${goal.tasks.length + 1}`,
    title,
    status: 'todo',
    session_id: null,
    evidence: null,
  }
  goal.tasks.push(task)
  goal.updated_at = input.now.toISOString()
  return { ok: true, value: task }
}

export function updateTask(
  goal: Goal,
  input: {
    taskId: string
    status?: TaskStatus
    evidence?: string
    sessionId?: string
    title?: string
    now: Date
  },
): Result<GoalTask> {
  const task = goal.tasks.find((t) => t.id === input.taskId)
  if (!task) return { ok: false, error: `no task ${input.taskId} on goal ${goal.id}` }
  if (input.status === 'done' && !(input.evidence ?? task.evidence)?.trim()) {
    return { ok: false, error: 'a done task needs evidence: a path, a link, or the check you ran' }
  }
  if (input.status) task.status = input.status
  if (input.evidence !== undefined) task.evidence = input.evidence.trim() || null
  if (input.sessionId !== undefined) task.session_id = input.sessionId.trim() || null
  if (input.title !== undefined && input.title.trim()) task.title = input.title.trim()
  goal.updated_at = input.now.toISOString()
  return { ok: true, value: task }
}

// ── the loop's decision ─────────────────────────────────────────────────────

export interface TurnObservation {
  /** The turn was stopped on purpose (`MessageAbortedError`). */
  aborted: boolean
  /** The turn ended in another error: the runtime's own retry owns it. */
  errored: boolean
  /** Tool calls the agent made in the turn that just ended. */
  toolCalls: number
}

export type LoopDecision =
  | { action: 'none' }
  | { action: 'paused'; goals: Goal[] }
  | { action: 'schedule'; wakeAt: Date }
  | { action: 'prompt'; prompt: string; goals: Goal[] }

/** What counts as progress: the board, the status and the evidence. */
export function goalFingerprint(goal: Goal): string {
  return JSON.stringify({
    status: goal.status,
    evidence: goal.evidence,
    tasks: goal.tasks.map((t) => [t.title, t.status, t.evidence ?? '', t.session_id ?? '']),
  })
}

/**
 * Decide what the harness does when `sessionId` goes idle. Mutates the goals
 * of that session in `file`; the caller persists it when the action is not
 * `none`.
 */
export function decideGoalLoop(
  file: GoalFile,
  sessionId: string,
  turn: TurnObservation,
  now: Date,
): LoopDecision {
  const active = file.goals.filter((g) => g.session_id === sessionId && g.status === 'active')
  if (active.length === 0 || turn.errored) return { action: 'none' }
  const stamp = now.toISOString()

  if (turn.aborted) {
    for (const goal of active) {
      goal.status = 'paused'
      goal.status_reason = 'Stopped by the user.'
      goal.updated_at = stamp
    }
    return { action: 'paused', goals: active }
  }

  const due = active.filter((g) => !g.next_wake_at || Date.parse(g.next_wake_at) <= now.getTime())
  if (due.length === 0) {
    return { action: 'schedule', wakeAt: new Date(Math.min(...active.map((g) => Date.parse(g.next_wake_at!)))) }
  }

  const continuing: Array<{ goal: Goal; replan: boolean }> = []
  const stopped: Goal[] = []
  for (const goal of due) {
    const fingerprint = goalFingerprint(goal)
    goal.no_progress_streak =
      goal.fingerprint === null || goal.fingerprint !== fingerprint ? 0 : goal.no_progress_streak + 1
    goal.fingerprint = fingerprint
    goal.empty_turn_streak = turn.toolCalls === 0 ? goal.empty_turn_streak + 1 : 0
    goal.next_wake_at = null
    goal.updated_at = stamp
    if (goal.empty_turn_streak >= EMPTY_TURN_LIMIT) {
      goal.status = 'blocked'
      goal.status_reason = `${EMPTY_TURN_LIMIT} turns in a row without any action.`
      stopped.push(goal)
    } else if (goal.no_progress_streak >= BLOCK_AFTER) {
      goal.status = 'blocked'
      goal.status_reason = `No progress on the task board in ${BLOCK_AFTER} turns.`
      stopped.push(goal)
    } else if (goal.continuations >= goal.max_continuations) {
      goal.status = 'limited'
      goal.status_reason = `Reached its limit of ${goal.max_continuations} continuations.`
      stopped.push(goal)
    } else {
      goal.continuations += 1
      continuing.push({ goal, replan: goal.no_progress_streak >= REPLAN_AFTER })
    }
  }
  return { action: 'prompt', prompt: renderContinuation(continuing, stopped), goals: due }
}

// ── rendering ───────────────────────────────────────────────────────────────

export function renderGoal(goal: Goal): string {
  const lines = [`## Goal ${goal.id} [${goal.status}]: ${goal.title}`, '', goal.objective, '']
  if (goal.status_reason) lines.push(`Status reason: ${goal.status_reason}`, '')
  if (goal.acceptance.length > 0) {
    lines.push('Acceptance criteria (each needs evidence before the goal is complete):')
    goal.acceptance.forEach((criterion, i) => lines.push(`${i + 1}. ${criterion}`))
    lines.push('')
  }
  lines.push('Task board:')
  if (goal.tasks.length === 0) lines.push('- (empty) Plan it with goal_task.')
  for (const task of goal.tasks) {
    const session = task.session_id ? ` (session ${task.session_id})` : ''
    const evidence = task.evidence ? ` — ${task.evidence}` : ''
    lines.push(`- ${task.id} [${task.status}] ${task.title}${session}${evidence}`)
  }
  lines.push('', `Continuations: ${goal.continuations} of ${goal.max_continuations}.`)
  return lines.join('\n')
}

export function renderContinuation(
  continuing: Array<{ goal: Goal; replan: boolean }>,
  stopped: Goal[],
): string {
  const lines: string[] = []
  if (continuing.length > 0) {
    lines.push('[Goal] Keep working. The goal is not done until every acceptance criterion has evidence.', '')
    for (const { goal, replan } of continuing) {
      lines.push(renderGoal(goal))
      if (replan) {
        lines.push(
          '',
          'The task board has not changed for 3 turns. Do not repeat the last step. ' +
            'Find out why it is stuck, change the plan, and record the new plan on the board.',
        )
      }
      lines.push('')
    }
    lines.push(
      'Do the next concrete step now. Current state is the truth: read worker replies and files before you rely on memory.',
    )
  }
  if (stopped.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('[Goal stopped by the harness]')
    for (const goal of stopped) lines.push(`- ${goal.id} (${goal.title}) is ${goal.status}: ${goal.status_reason}`)
    lines.push(
      'Tell the user what is done, what is stuck, and what you need. They resume it by asking you to continue.',
    )
  }
  return lines.join('\n')
}

/** The block injected into every turn's system prompt while goals are open. */
export function renderGoalContext(goals: Goal[]): string | null {
  const open = goals.filter((g) => g.status !== 'complete' && g.status !== 'cancelled')
  if (open.length === 0) return null
  return [
    '# Your goals',
    'These goals persist across turns and context resets. Keep the task board current.',
    '',
    ...open.map(renderGoal),
    '',
    'Goal rules:',
    '- goal_task: add tasks, and set status/evidence/session as work moves. A done task needs evidence.',
    '- A worker saying "done" is a claim. Verify it before you mark a task done.',
    '- goal_update status=complete needs one evidence item per acceptance criterion.',
    '- Waiting on workers or time: goal_wake with minutes, then end your turn. Workers you wait on with `kortix sessions wait-for` need no wake.',
    '- A decision only the user can make: goal_update status=waiting with the question, then ask it.',
    '- When the user asks you to continue a paused, blocked or waiting goal: goal_update status=active.',
    '- Never stop because the work is hard or slow. The harness continues an active goal after every turn.',
  ].join('\n')
}
