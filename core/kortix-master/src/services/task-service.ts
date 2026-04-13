import { Database } from 'bun:sqlite'

export type TaskStatus = 'todo' | 'in_progress' | 'input_needed' | 'awaiting_review' | 'completed' | 'cancelled'

export type TaskEventType =
  | 'progress'
  | 'blocker'
  | 'evidence'
  | 'verification_started'
  | 'verification_passed'
  | 'verification_failed'
  | 'delivered'

export type TaskRunStatus = 'running' | 'input_needed' | 'awaiting_review' | 'completed' | 'cancelled' | 'failed'

export interface TaskRow {
  id: string
  project_id: string
  title: string
  description: string
  verification_condition: string
  status: TaskStatus
  result: string | null
  verification_summary: string | null
  blocking_question: string | null
  owner_session_id: string | null
  owner_agent: string | null
  parent_session_id: string | null
  started_at: string | null
  completed_at: string | null
  latest_run_id?: string | null
  created_at: string
  updated_at: string
}

export interface TaskRunRow {
  id: string
  task_id: string
  project_id: string
  parent_session_id: string | null
  owner_session_id: string | null
  owner_agent: string | null
  status: TaskRunStatus
  result: string | null
  verification_summary: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

export interface TaskLiveStatus {
  task_id: string
  status: TaskStatus
  latest_run_id: string | null
  run_status: TaskRunStatus | null
  owner_session_id: string | null
  detail: string
}

export interface TaskEventRow {
  id: string
  task_id: string
  project_id: string
  task_run_id: string | null
  session_id: string | null
  type: TaskEventType
  message: string | null
  payload_json: string | null
  created_at: string
}

export interface ProjectRow {
  id: string
  name: string
  path: string
  description: string
}

export interface OpenCodeClientLike {
  session: {
    create(args: any): Promise<any>
    promptAsync(args: any): Promise<any>
    status?(): Promise<any>
    abort?(args: any): Promise<any>
    messages?(args: any): Promise<any>
  }
}

export interface StartTaskOptions {
  db: Database
  client: OpenCodeClientLike
  taskId: string
  parentSessionId?: string | null
  bindSessionProject?: (sessionId: string, projectId: string) => void | Promise<void>
  workerAgent?: string
  onWorkerSessionCreated?: (sessionId: string) => void
}

export interface CreateTaskInput {
  id?: string
  project_id: string
  title: string
  description?: string
  verification_condition?: string
  status?: string
}

export const VALID_TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'input_needed', 'awaiting_review', 'completed', 'cancelled']
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['completed', 'cancelled']
export const ACTIVE_REVIEW_STATUSES: TaskStatus[] = ['awaiting_review']

export const STATUS_ORDER_SQL = `CASE status
  WHEN 'in_progress' THEN 0
  WHEN 'input_needed' THEN 1
  WHEN 'awaiting_review' THEN 2
  WHEN 'todo' THEN 3
  WHEN 'completed' THEN 4
  WHEN 'cancelled' THEN 5
  ELSE 99 END`

export const PATCH_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['cancelled'],
  in_progress: ['input_needed', 'awaiting_review', 'todo', 'cancelled'],
  input_needed: ['todo', 'cancelled'],
  awaiting_review: ['todo', 'cancelled'],
  completed: [],
  cancelled: ['todo'],
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function genTaskId(): string {
  return `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function genTaskEventId(): string {
  return `tevt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function genTaskRunId(): string {
  return `trun-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function ensureTasksTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      verification_condition TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      result TEXT,
      verification_summary TEXT,
      blocking_question TEXT,
      owner_session_id TEXT,
      owner_agent TEXT,
      parent_session_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      latest_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_session_id TEXT,
      owner_session_id TEXT,
      owner_agent TEXT,
      status TEXT NOT NULL,
      result TEXT,
      verification_summary TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_run_id TEXT,
      session_id TEXT,
      type TEXT NOT NULL,
      message TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      set_at TEXT NOT NULL
    );
  `)
  try { db.exec(`ALTER TABLE tasks ADD COLUMN verification_condition TEXT NOT NULL DEFAULT ''`) } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN verification_summary TEXT`) } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN blocking_question TEXT`) } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN owner_session_id TEXT`) } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN owner_agent TEXT`) } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN parent_session_id TEXT`) } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN started_at TEXT`) } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN completed_at TEXT`) } catch {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN latest_run_id TEXT') } catch {}
  try { db.exec('ALTER TABLE task_events ADD COLUMN task_run_id TEXT') } catch {}
  try { db.exec(`UPDATE tasks SET status='todo' WHERE status='pending'`) } catch {}
  try { db.exec(`UPDATE tasks SET status='completed' WHERE status='done'`) } catch {}
  try { db.exec(`UPDATE tasks SET status='input_needed' WHERE status='blocked'`) } catch {}
}

export function getTaskById(db: Database, id: string): TaskRow | null {
  ensureTasksTable(db)
  return db.prepare('SELECT * FROM tasks WHERE id=$id').get({ $id: id }) as TaskRow | null
}

export function getTaskByOwnerSession(db: Database, sessionId: string): TaskRow | null {
  ensureTasksTable(db)
  return db.prepare('SELECT * FROM tasks WHERE owner_session_id=$sid').get({ $sid: sessionId }) as TaskRow | null
}

export function getTaskRunById(db: Database, id: string): TaskRunRow | null {
  ensureTasksTable(db)
  return db.prepare('SELECT * FROM task_runs WHERE id=$id').get({ $id: id }) as TaskRunRow | null
}

export function getTaskRunByOwnerSession(db: Database, sessionId: string): TaskRunRow | null {
  ensureTasksTable(db)
  return db.prepare(`SELECT * FROM task_runs WHERE owner_session_id=$sid ORDER BY created_at DESC LIMIT 1`).get({ $sid: sessionId }) as TaskRunRow | null
}

export function getLatestTaskRun(db: Database, taskId: string): TaskRunRow | null {
  ensureTasksTable(db)
  return db.prepare('SELECT * FROM task_runs WHERE task_id=$id ORDER BY created_at DESC LIMIT 1').get({ $id: taskId }) as TaskRunRow | null
}

export function getTaskByIdForProject(db: Database, id: string, projectId: string): TaskRow | null {
  ensureTasksTable(db)
  return db.prepare('SELECT * FROM tasks WHERE id=$id AND project_id=$pid').get({ $id: id, $pid: projectId }) as TaskRow | null
}

export function listTasks(db: Database, filters: { projectId?: string; status?: string } = {}): TaskRow[] {
  ensureTasksTable(db)
  let q = 'SELECT * FROM tasks WHERE 1=1'
  const params: Record<string, string> = {}
  if (filters.projectId) {
    q += ' AND project_id=$pid'
    params.$pid = filters.projectId
  }
  if (filters.status) {
    q += ' AND status=$s'
    params.$s = filters.status
  }
  q += ` ORDER BY ${STATUS_ORDER_SQL}, created_at DESC LIMIT 500`
  return db.prepare(q).all(params) as TaskRow[]
}

export async function listTasksResolved(db: Database, client: OpenCodeClientLike, filters: { projectId?: string; status?: string } = {}): Promise<TaskRow[]> {
  const tasks = listTasks(db, filters)
  return reconcileTasksIfIdle(db, client, tasks)
}

export async function getTaskResolved(db: Database, client: OpenCodeClientLike, id: string): Promise<TaskRow | null> {
  const task = getTaskById(db, id)
  if (!task) return null
  return reconcileTaskIfIdle(db, client, task)
}

export async function getTaskResolvedForProject(db: Database, client: OpenCodeClientLike, id: string, projectId: string): Promise<TaskRow | null> {
  const task = getTaskByIdForProject(db, id, projectId)
  if (!task) return null
  return reconcileTaskIfIdle(db, client, task)
}

export function listTaskEvents(db: Database, taskId: string): TaskEventRow[] {
  ensureTasksTable(db)
  return db.prepare('SELECT * FROM task_events WHERE task_id=$id ORDER BY created_at DESC LIMIT 200').all({ $id: taskId }) as TaskEventRow[]
}

export async function getTaskLiveStatus(db: Database, client: OpenCodeClientLike, taskId: string): Promise<TaskLiveStatus> {
  ensureTasksTable(db)
  const task = await getTaskResolved(db, client, taskId)
  if (!task) throw new Error('Task not found')
  const run = task.latest_run_id ? getTaskRunById(db, task.latest_run_id) : getLatestTaskRun(db, task.id)
  const run_status = run?.status || null

  const detail =
    task.status === 'in_progress'
      ? 'Task is actively running in a live worker session.'
      : task.status === 'awaiting_review'
        ? 'Task has structured delivery and is awaiting review/approval.'
        : task.status === 'input_needed'
          ? 'Task is blocked and requires input or a decision.'
          : task.status === 'completed'
            ? 'Task is completed.'
            : task.status === 'cancelled'
              ? 'Task is cancelled or the last run failed/was stopped.'
              : 'Task is ready to be started.'

  return {
    task_id: task.id,
    status: task.status,
    latest_run_id: run?.id || task.latest_run_id || null,
    run_status,
    owner_session_id: task.owner_session_id || run?.owner_session_id || null,
    detail,
  }
}

export async function reconcileAllRunningTasks(db: Database, client: OpenCodeClientLike): Promise<number> {
  ensureTasksTable(db)
  const running = db.prepare(`SELECT * FROM tasks WHERE status='in_progress'`).all() as TaskRow[]
  if (!running.length) return 0
  const reconciled = await reconcileTasksIfIdle(db, client, running)
  let changed = 0
  for (let i = 0; i < running.length; i++) {
    if (running[i].status !== reconciled[i].status) changed++
  }
  return changed
}

function resolveTaskRunId(db: Database, task: TaskRow, sessionId?: string | null): string | null {
  if (sessionId) {
    const sessionRun = getTaskRunByOwnerSession(db, sessionId)
    if (sessionRun?.task_id === task.id) return sessionRun.id
  }
  if (task.latest_run_id) return task.latest_run_id
  return getLatestTaskRun(db, task.id)?.id || null
}

function updateTaskRun(db: Database, runId: string | null, patch: Partial<TaskRunRow>): void {
  if (!runId) return
  const now = patch.updated_at ?? nowIso()
  const run = getTaskRunById(db, runId)
  if (!run) return
  const next = { ...run, ...patch, updated_at: now }
  db.prepare(`UPDATE task_runs SET
      parent_session_id=$parentSessionId,
      owner_session_id=$ownerSessionId,
      owner_agent=$ownerAgent,
      status=$status,
      result=$result,
      verification_summary=$verificationSummary,
      started_at=$startedAt,
      completed_at=$completedAt,
      updated_at=$updatedAt
    WHERE id=$id`).run({
    $parentSessionId: next.parent_session_id,
    $ownerSessionId: next.owner_session_id,
    $ownerAgent: next.owner_agent,
    $status: next.status,
    $result: next.result,
    $verificationSummary: next.verification_summary,
    $startedAt: next.started_at,
    $completedAt: next.completed_at,
    $updatedAt: next.updated_at,
    $id: runId,
  })
}

function mapRunStatusToTaskStatus(status: TaskRunStatus): TaskStatus {
  switch (status) {
    case 'running': return 'in_progress'
    case 'input_needed': return 'input_needed'
    case 'awaiting_review': return 'awaiting_review'
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'cancelled'
    default: return 'todo'
  }
}

export function syncTaskFromLatestRun(db: Database, taskId: string): TaskRow | null {
  ensureTasksTable(db)
  const task = getTaskById(db, taskId)
  if (!task) return null
  const latestRun = getLatestTaskRun(db, taskId)
  if (!latestRun) return task

  db.prepare(`UPDATE tasks SET
      status=$status,
      result=$result,
      verification_summary=$verificationSummary,
      owner_session_id=$ownerSessionId,
      owner_agent=$ownerAgent,
      parent_session_id=$parentSessionId,
      started_at=COALESCE($startedAt, started_at),
      completed_at=$completedAt,
      latest_run_id=$latestRunId,
      updated_at=$updatedAt
    WHERE id=$id`).run({
    $status: mapRunStatusToTaskStatus(latestRun.status),
    $result: latestRun.result,
    $verificationSummary: latestRun.verification_summary,
    $ownerSessionId: latestRun.owner_session_id,
    $ownerAgent: latestRun.owner_agent,
    $parentSessionId: latestRun.parent_session_id,
    $startedAt: latestRun.started_at,
    $completedAt: latestRun.completed_at,
    $latestRunId: latestRun.id,
    $updatedAt: nowIso(),
    $id: taskId,
  })
  return getTaskById(db, taskId)
}

export function recordTaskEvent(db: Database, input: {
  taskId: string
  sessionId?: string | null
  type: TaskEventType
  message?: string | null
  payload?: unknown
}): TaskEventRow {
  ensureTasksTable(db)
  const task = getTaskById(db, input.taskId)
  if (!task) throw new Error('Task not found')
  const row: TaskEventRow = {
    id: genTaskEventId(),
    task_id: task.id,
    project_id: task.project_id,
    task_run_id: resolveTaskRunId(db, task, input.sessionId),
    session_id: input.sessionId ?? null,
    type: input.type,
    message: input.message ?? null,
    payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
    created_at: nowIso(),
  }
  db.prepare(`INSERT INTO task_events (id, task_id, project_id, task_run_id, session_id, type, message, payload_json, created_at)
    VALUES ($id, $taskId, $projectId, $taskRunId, $sessionId, $type, $message, $payload, $createdAt)`).run({
    $id: row.id,
    $taskId: row.task_id,
    $projectId: row.project_id,
    $taskRunId: row.task_run_id,
    $sessionId: row.session_id,
    $type: row.type,
    $message: row.message,
    $payload: row.payload_json,
    $createdAt: row.created_at,
  })
  return row
}

export function progressTask(db: Database, input: { taskId: string; sessionId?: string | null; message: string; payload?: unknown }): TaskRow {
  recordTaskEvent(db, { taskId: input.taskId, sessionId: input.sessionId, type: 'progress', message: input.message, payload: input.payload })
  const now = nowIso()
  updateTaskRun(db, getTaskById(db, input.taskId)?.latest_run_id || null, { updated_at: now })
  db.prepare('UPDATE tasks SET updated_at=$now WHERE id=$id').run({ $now: now, $id: input.taskId })
  return getTaskById(db, input.taskId)!
}

export function blockTask(db: Database, input: { taskId: string; sessionId?: string | null; message: string; payload?: unknown }): TaskRow {
  recordTaskEvent(db, { taskId: input.taskId, sessionId: input.sessionId, type: 'blocker', message: input.message, payload: input.payload })
  const now = nowIso()
  updateTaskRun(db, getTaskById(db, input.taskId)?.latest_run_id || null, { status: 'input_needed', updated_at: now })
  db.prepare(`UPDATE tasks SET status='input_needed', blocking_question=$message, updated_at=$now WHERE id=$id`).run({
    $message: input.message,
    $now: now,
    $id: input.taskId,
  })
  const synced = syncTaskFromLatestRun(db, input.taskId)
  if (synced) return { ...synced, blocking_question: input.message }
  return getTaskById(db, input.taskId)!
}

export function addTaskEvidence(db: Database, input: { taskId: string; sessionId?: string | null; message?: string | null; payload?: unknown }): TaskRow {
  recordTaskEvent(db, { taskId: input.taskId, sessionId: input.sessionId, type: 'evidence', message: input.message, payload: input.payload })
  const now = nowIso()
  updateTaskRun(db, getTaskById(db, input.taskId)?.latest_run_id || null, { updated_at: now })
  db.prepare('UPDATE tasks SET updated_at=$now WHERE id=$id').run({ $now: now, $id: input.taskId })
  return getTaskById(db, input.taskId)!
}

export function deliverTask(db: Database, input: {
  taskId: string
  sessionId?: string | null
  result: string
  verificationSummary?: string | null
  message?: string | null
  payload?: unknown
}): TaskRow {
  recordTaskEvent(db, {
    taskId: input.taskId,
    sessionId: input.sessionId,
    type: 'delivered',
    message: input.message ?? 'Task delivered for review',
    payload: {
      verificationSummary: input.verificationSummary ?? null,
      ...(input.payload && typeof input.payload === 'object' ? input.payload as object : {}),
    },
  })
  const now = nowIso()
  updateTaskRun(db, getTaskById(db, input.taskId)?.latest_run_id || null, {
    status: 'awaiting_review',
    result: input.result,
    verification_summary: input.verificationSummary ?? null,
    completed_at: now,
    updated_at: now,
  })
  db.prepare(`UPDATE tasks SET
      status='awaiting_review',
      result=$result,
      verification_summary=$verification,
      blocking_question=NULL,
      updated_at=$now
    WHERE id=$id`).run({
    $result: input.result,
    $verification: input.verificationSummary ?? null,
    $now: now,
    $id: input.taskId,
  })
  return syncTaskFromLatestRun(db, input.taskId) || getTaskById(db, input.taskId)!
}

export async function reconcileTaskIfIdle(db: Database, client: OpenCodeClientLike, task: TaskRow): Promise<TaskRow> {
  if (task.status !== 'in_progress') return task
  if (!task.owner_session_id) {
    const now = nowIso()
    recordTaskEvent(db, {
      taskId: task.id,
      type: 'verification_failed',
      message: 'Task was marked in_progress without a bound worker session; treating run as failed.',
    })
    updateTaskRun(db, task.latest_run_id || null, {
      status: 'failed',
      result: 'Task was marked in_progress without a bound worker session.',
      completed_at: now,
      updated_at: now,
    })
    db.prepare(`UPDATE tasks SET status='cancelled', result=$result, completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id AND status='in_progress'`)
      .run({ $result: 'Task was marked in_progress without a bound worker session.', $now: now, $id: task.id })
    return syncTaskFromLatestRun(db, task.id) || { ...task, status: 'cancelled', result: 'Task was marked in_progress without a bound worker session.', completed_at: now, updated_at: now }
  }
  if (!client.session.status) return task
  try {
    const statusRes = await client.session.status()
    const sessionStatuses = statusRes.data as Record<string, { type: string }> | undefined
    const sessionStatus = sessionStatuses?.[task.owner_session_id]
    if (!sessionStatus || sessionStatus.type === 'idle') {
      const now = nowIso()
      recordTaskEvent(db, {
        taskId: task.id,
        sessionId: task.owner_session_id,
        type: 'verification_failed',
        message: 'Worker session became idle without structured task_deliver; treating run as failed.',
      })
      updateTaskRun(db, task.latest_run_id || null, {
        status: 'failed',
        result: 'Worker session became idle without structured task_deliver.',
        completed_at: now,
        updated_at: now,
      })
      db.prepare(`UPDATE tasks SET status='cancelled', result=$result, completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id AND status='in_progress'`)
        .run({
          $result: 'Worker session became idle without structured task_deliver.',
          $now: now,
          $id: task.id,
        })
      return syncTaskFromLatestRun(db, task.id) || { ...task, status: 'cancelled', result: 'Worker session became idle without structured task_deliver.', completed_at: now, updated_at: now }
    }
  } catch {
    // best-effort only
  }
  return task
}

export async function reconcileTasksIfIdle(db: Database, client: OpenCodeClientLike, tasks: TaskRow[]): Promise<TaskRow[]> {
  const candidates = tasks.filter((t) => t.status === 'in_progress')
  if (!candidates.length) return tasks
  if (!client.session.status) {
    return Promise.all(tasks.map((task) => reconcileTaskIfIdle(db, client, task)))
  }
  try {
    const statusRes = await client.session.status()
    const sessionStatuses = statusRes.data as Record<string, { type: string }> | undefined
    if (!sessionStatuses) return tasks
    const now = nowIso()
    return tasks.map((task) => {
      if (task.status !== 'in_progress') return task
      if (!task.owner_session_id) {
        recordTaskEvent(db, {
          taskId: task.id,
          type: 'verification_failed',
          message: 'Task was marked in_progress without a bound worker session; treating run as failed.',
        })
        updateTaskRun(db, task.latest_run_id || null, {
          status: 'failed',
          result: 'Task was marked in_progress without a bound worker session.',
          completed_at: now,
          updated_at: now,
        })
        db.prepare(`UPDATE tasks SET status='cancelled', result=$result, completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id AND status='in_progress'`)
          .run({
            $result: 'Task was marked in_progress without a bound worker session.',
            $now: now,
            $id: task.id,
          })
        return syncTaskFromLatestRun(db, task.id) || { ...task, status: 'cancelled', result: 'Task was marked in_progress without a bound worker session.', completed_at: now, updated_at: now }
      }
      const sessionStatus = sessionStatuses[task.owner_session_id]
      if (!sessionStatus || sessionStatus.type === 'idle') {
        recordTaskEvent(db, {
          taskId: task.id,
          sessionId: task.owner_session_id,
          type: 'verification_failed',
          message: 'Worker session became idle without structured task_deliver; treating run as failed.',
        })
        updateTaskRun(db, task.latest_run_id || null, {
          status: 'failed',
          result: 'Worker session became idle without structured task_deliver.',
          completed_at: now,
          updated_at: now,
        })
        db.prepare(`UPDATE tasks SET status='cancelled', result=$result, completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id AND status='in_progress'`)
          .run({
            $result: 'Worker session became idle without structured task_deliver.',
            $now: now,
            $id: task.id,
          })
        return syncTaskFromLatestRun(db, task.id) || { ...task, status: 'cancelled', result: 'Worker session became idle without structured task_deliver.', completed_at: now, updated_at: now }
      }
      return task
    })
  } catch {
    return tasks
  }
}

export function createTask(db: Database, input: CreateTaskInput): TaskRow {
  ensureTasksTable(db)
  const id = input.id || genTaskId()
  const now = nowIso()
  let status = (input.status || 'todo') as TaskStatus
  if (status === 'in_progress' || status === 'awaiting_review') status = 'todo'
  if (!VALID_TASK_STATUSES.includes(status)) status = 'todo'
  db.prepare(`INSERT INTO tasks (
      id, project_id, title, description, verification_condition,
      status, result, verification_summary, blocking_question,
      owner_session_id, owner_agent, parent_session_id,
      started_at, completed_at, created_at, updated_at
    ) VALUES (
      $id, $pid, $title, $desc, $vc,
      $status, NULL, NULL, NULL,
      NULL, NULL, NULL,
      NULL, NULL, $now, $now
    )`).run({
    $id: id,
    $pid: input.project_id,
    $title: input.title,
    $desc: input.description || '',
    $vc: input.verification_condition || '',
    $status: status,
    $now: now,
  })
  return getTaskById(db, id)!
}

export function buildOwnerPrompt(project: ProjectRow, task: TaskRow): string {
  return [
    `/autowork --max-iterations 50`,
    '',
    'You are the single responsible owner for one task.',
    '',
    'Project:',
    `- name: ${project.name}`,
    `- id: ${project.id}`,
    `- path: ${project.path}`,
    `- context: ${project.path}/.kortix/CONTEXT.md`,
    '',
    'Task:',
    `- id: ${task.id}`,
    `- title: ${task.title}`,
    `- description: ${task.description || '(none)'}`,
    `- verification_condition: ${task.verification_condition || '(none)'}`,
    `- status: ${task.status}`,
    '',
    'Execution contract:',
    `- FIRST: run project_select("${project.name}") to link this session to the project.`,
    `- SECOND: read ${project.path}/.kortix/CONTEXT.md before making changes. Treat it as the shared project memory spine.`,
    '- You own exactly this one task for this run. Stay within scope and satisfy the verification condition.',
    '- Use task_progress for meaningful progress updates and task_evidence for important artifacts.',
    '- If blocked, call task_blocker with the exact missing input/decision.',
    '- When verification starts or finishes, record it with task_verification.',
    '- When the work is complete, call task_deliver with result and verification_summary.',
    '- If you need to revisit the task details, use the task block above in this prompt as the source of truth.',
    '- Durable project docs (.kortix/CONTEXT.md) are maintained automatically by the hidden project-maintainer after each task event; you do not need to update them yourself.',
    '',
    'Completion contract:',
    '- The autowork loop stops when — and only when — you emit a <kortix_autowork_complete> tag with two children:',
    '  - <verification> containing the exact commands you ran and their real output (proof the task works).',
    '  - <requirements_check> containing a checklist where EVERY user / task requirement is `- [x] "requirement" — evidence` with concrete proof.',
    '- Malformed, empty, or unchecked items → the plugin rejects the tag and continues the loop.',
    "- After `task_deliver` succeeds, emit the completion tag. The autowork plugin will parse it and close the loop.",
  ].join('\n')
}

async function bindSessionProjectDefault(db: Database, sessionId: string, projectId: string): Promise<void> {
  ensureTasksTable(db)
  db.prepare(`INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)`)
    .run({ $sid: sessionId, $pid: projectId, $now: nowIso() })
}

async function ensureSessionProjectBinding(
  db: Database,
  sessionId: string,
  projectId: string,
  bindSessionProject?: (sessionId: string, projectId: string) => void | Promise<void>,
): Promise<void> {
  if (bindSessionProject) await bindSessionProject(sessionId, projectId)
  else await bindSessionProjectDefault(db, sessionId, projectId)

  const linked = db.prepare('SELECT 1 FROM session_projects WHERE session_id=$sid AND project_id=$pid LIMIT 1').get({
    $sid: sessionId,
    $pid: projectId,
  })
  if (!linked) throw new Error(`Failed to bind session ${sessionId} to project ${projectId}`)
}

export async function startTask(options: StartTaskOptions): Promise<TaskRow> {
  const {
    db,
    client,
    taskId,
    parentSessionId = null,
    bindSessionProject,
    workerAgent = 'worker',
    onWorkerSessionCreated,
  } = options

  ensureTasksTable(db)
  const task = getTaskById(db, taskId)
  if (!task) throw new Error('Task not found')
  if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new Error('Cannot start a terminal task')
  if (task.status === 'in_progress') throw new Error('Task is already in progress')

  const project = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: task.project_id }) as ProjectRow | null
  if (!project) throw new Error('Project not found')

  const now = nowIso()

  const runId = genTaskRunId()
  db.prepare(`INSERT INTO task_runs (
      id, task_id, project_id, parent_session_id,
      owner_session_id, owner_agent, status, result, verification_summary,
      created_at, started_at, completed_at, updated_at
    ) VALUES (
      $id, $taskId, $projectId, $parentSessionId,
      NULL, $ownerAgent, 'running', NULL, NULL,
      $now, $now, NULL, $now
    )`).run({
    $id: runId,
    $taskId: task.id,
    $projectId: task.project_id,
    $parentSessionId: parentSessionId,
    $ownerAgent: workerAgent,
    $now: now,
  })

  if (task.owner_session_id) {
    try {
      const resumePrompt = [
        '/autowork --max-iterations 50',
        '',
        `Task ${task.id} has been restarted. Resume ownership now.`,
        'Use the task already in this session as the source of truth.',
        'When complete, emit <kortix_autowork_complete> with <verification> and <requirements_check> children.',
      ].join('\n')

      await client.session.promptAsync({
        path: { id: task.owner_session_id },
        body: { agent: workerAgent, parts: [{ type: 'text', text: resumePrompt }] },
      })

      await ensureSessionProjectBinding(db, task.owner_session_id, project.id, bindSessionProject)

      updateTaskRun(db, runId, {
        owner_session_id: task.owner_session_id,
        owner_agent: workerAgent,
        parent_session_id: parentSessionId,
        started_at: now,
        status: 'running',
      })

      db.prepare(`UPDATE tasks SET status='in_progress', parent_session_id=COALESCE($psid, parent_session_id), latest_run_id=$runId, started_at=COALESCE(started_at, $now), updated_at=$now WHERE id=$id`)
        .run({ $psid: parentSessionId, $runId: runId, $now: now, $id: task.id })

      if (onWorkerSessionCreated) onWorkerSessionCreated(task.owner_session_id)
      return syncTaskFromLatestRun(db, task.id) || getTaskById(db, task.id)!
    } catch {
      db.prepare('DELETE FROM task_runs WHERE id=$id').run({ $id: runId })
      // fall through and create a fresh worker session
    }
  }

  const sessionResult = await client.session.create({
    body: parentSessionId
      ? { parentID: parentSessionId, title: `${task.title} [${task.id}]` }
      : { title: `Task ${task.id}: ${task.title}` },
  })
  const ownerSessionId = sessionResult.data?.id
  if (!ownerSessionId) throw new Error('Failed to create worker session')

  await ensureSessionProjectBinding(db, ownerSessionId, project.id, bindSessionProject)

  if (onWorkerSessionCreated) onWorkerSessionCreated(ownerSessionId)

  const prompt = buildOwnerPrompt(project, task)
  try {
    await client.session.promptAsync({
      path: { id: ownerSessionId },
      body: { agent: workerAgent, parts: [{ type: 'text', text: prompt }] },
    })
  } catch (error) {
    db.prepare('DELETE FROM task_runs WHERE id=$id').run({ $id: runId })
    throw error
  }

  updateTaskRun(db, runId, {
    owner_session_id: ownerSessionId,
    owner_agent: workerAgent,
    parent_session_id: parentSessionId,
    started_at: now,
    status: 'running',
  })

  db.prepare(`UPDATE tasks SET
      status='in_progress',
      owner_session_id=$sid,
      owner_agent=$agent,
      parent_session_id=$psid,
      latest_run_id=$runId,
      started_at=COALESCE(started_at, $now),
      updated_at=$now
    WHERE id=$id`).run({
    $sid: ownerSessionId,
    $agent: workerAgent,
    $psid: parentSessionId,
    $runId: runId,
    $now: now,
    $id: task.id,
  })

  return syncTaskFromLatestRun(db, task.id) || getTaskById(db, task.id)!
}

export function approveTask(db: Database, id: string): TaskRow {
  ensureTasksTable(db)
  const task = getTaskById(db, id)
  if (!task) throw new Error('Task not found')
  if (!ACTIVE_REVIEW_STATUSES.includes(task.status)) throw new Error('Can only approve tasks awaiting human review')
  const now = nowIso()
  updateTaskRun(db, task.latest_run_id || null, { status: 'completed', completed_at: now, updated_at: now })
  db.prepare(`UPDATE tasks SET status='completed', completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id`)
    .run({ $now: now, $id: id })
  recordTaskEvent(db, { taskId: id, type: 'verification_passed', message: 'Task approved and completed' })
  return syncTaskFromLatestRun(db, id) || getTaskById(db, id)!
}

export function patchTask(db: Database, id: string, body: Partial<TaskRow>): TaskRow {
  ensureTasksTable(db)
  const task = getTaskById(db, id)
  if (!task) throw new Error('Task not found')

  if (body.status !== undefined) {
    if (body.status === 'in_progress') throw new Error('Use POST /:id/start')
    if (body.status === 'completed') throw new Error('Use POST /:id/approve')
    if (!VALID_TASK_STATUSES.includes(body.status as TaskStatus)) throw new Error(`Invalid status: ${body.status}`)
    const allowed = PATCH_TRANSITIONS[task.status] || []
    if (!allowed.includes(body.status as TaskStatus)) {
      throw new Error(`Cannot transition from ${task.status} to ${body.status}`)
    }
  }

  const patchable: Array<keyof TaskRow> = [
    'title',
    'description',
    'verification_condition',
    'status',
    'result',
    'verification_summary',
    'blocking_question',
    'owner_session_id',
    'owner_agent',
  ]

  const now = nowIso()
  for (const field of patchable) {
    if (body[field] !== undefined) {
      db.prepare(`UPDATE tasks SET ${field}=$v, updated_at=$now WHERE id=$id`).run({
        $v: body[field] as any,
        $now: now,
        $id: id,
      })
    }
  }

  if (body.status === 'cancelled' && !task.completed_at) {
    db.prepare('UPDATE tasks SET completed_at=$now WHERE id=$id').run({ $now: now, $id: id })
  }

  return getTaskById(db, id)!
}

export async function cancelTask(db: Database, client: OpenCodeClientLike, id: string): Promise<TaskRow> {
  ensureTasksTable(db)
  const task = getTaskById(db, id)
  if (!task) throw new Error('Task not found')
  if (task.status === 'completed') throw new Error('Cannot cancel a completed task')
  if (task.owner_session_id && task.status === 'in_progress' && client.session.abort) {
    try { await client.session.abort({ path: { id: task.owner_session_id } }) } catch {}
  }
  const now = nowIso()
  updateTaskRun(db, task.latest_run_id || null, { status: 'cancelled', completed_at: now, updated_at: now })
  db.prepare(`UPDATE tasks SET status='cancelled', completed_at=COALESCE(completed_at, $now), updated_at=$now WHERE id=$id`)
    .run({ $now: now, $id: id })
  return syncTaskFromLatestRun(db, id) || getTaskById(db, id)!
}

export function deleteTask(db: Database, id: string): void {
  ensureTasksTable(db)
  db.prepare('DELETE FROM task_events WHERE task_id=$id').run({ $id: id })
  db.prepare('DELETE FROM task_runs WHERE task_id=$id').run({ $id: id })
  db.prepare('DELETE FROM tasks WHERE id=$id').run({ $id: id })
}
