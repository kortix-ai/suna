/**
 * A team's shared task list for pi: `task_create`, `task_list`, `task_get`
 * and `task_update`, Kortix's version of Claude Code's agent-team task tools
 * (https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks). The
 * list lives in the API (`session_tasks`, one list per lead session), so the
 * lead and every teammate read and write the same one from their own boxes:
 *
 * | Tool | Call |
 * | --- | --- |
 * | `task_create` | `POST /v1/projects/:id/sessions/:lead/tasks` (`SessionTaskCreateBody`) → `201 SessionTask` |
 * | `task_list` | `GET /v1/projects/:id/sessions/:lead/tasks` → `{ tasks }` |
 * | `task_get` | the same list, one task |
 * | `task_update` | `PATCH /v1/projects/:id/sessions/:lead/tasks/:seq` (`SessionTaskUpdateBody`) → `SessionTask`; `409 task_taken`/`task_blocked` |
 *
 * `:lead` is this session for a team lead, and the session in the
 * `kortix.team.lead` runtime context key for a teammate (the lead started it
 * with that key, and with metadata `team_lead`). A claim is atomic in the API:
 * only a pending, unowned, unblocked task, and the loser of a race gets
 * `task_taken`.
 *
 * Registered only while the project's `agent_teams` flag is on and the session
 * is a lead (depth 0) or a teammate (runtime.ts `multiAgentExtensions`).
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { KortixCardRow } from '@kortix/api-contract/kortix-tool-card'
import {
  SESSION_TASK_BLOCKED_CODE,
  SESSION_TASK_TAKEN_CODE,
  type SessionTask,
  type SessionTaskCreateBody,
  type SessionTaskStatus,
  type SessionTaskUpdateBody,
} from '@kortix/api-contract/multi-agent'
import { Type } from 'typebox'
import { apiErrorMessage, callApi, errorKind, failure, sessionPath, toolReturn, type ApiAnswer, type ControlPlane, type MultiAgentToolResult } from './control-plane'

export const TEAM_TASK_TOOLS = ['task_create', 'task_list', 'task_get', 'task_update'] as const

/** What the task tools need from the runtime. */
export interface TeamTasksHost {
  controlPlane(): ControlPlane | null
  /** The lead session whose list this session uses: itself as a lead, its lead as a teammate. */
  teamLead(): string
  /** True for a teammate: its descriptions say how to claim work. */
  isTeammate(): boolean
}

const createParameters = Type.Object({
  subject: Type.String({ description: 'A short imperative title, e.g. "Review the auth module".' }),
  description: Type.Optional(Type.String({ description: 'What done looks like: the files, the checks, the deliverable.' })),
  blocked_by: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: 'Task numbers that must be completed first.' })),
  owner: Type.Optional(Type.String({ description: 'Assign it to a teammate now, by name.' })),
})
const listParameters = Type.Object({})
const getParameters = Type.Object({ seq: Type.Integer({ minimum: 1, description: 'The task number (#3 is 3).' }) })
const updateParameters = Type.Object({
  seq: Type.Integer({ minimum: 1, description: 'The task number (#3 is 3).' }),
  claim: Type.Optional(Type.Boolean({ description: 'true: take the task for yourself. Only a pending, unowned, unblocked task; if another teammate was faster, the result says so.' })),
  status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')], { description: 'The new state.' })),
  owner: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Assign it to a teammate by name, or null to release it.' })),
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  add_blocked_by: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: 'More task numbers this task waits for.' })),
})

type CreateParams = SessionTaskCreateBody
type UpdateParams = SessionTaskUpdateBody & { seq: number }

function descriptions(teammate: boolean): Record<(typeof TEAM_TASK_TOOLS)[number], string> {
  const flow = teammate
    ? 'You are a teammate: claim the next pending, unowned, unblocked task with task_update { seq, claim: true }, do it, mark it { status: "completed" }, then claim the next. When nothing is left for you, send the lead your result with send_message and end your turn.'
    : 'You lead this team: split the work into self-contained tasks (5-6 per teammate keeps everyone busy), start teammates with the agent tool and a name, and let them claim tasks. Assign one directly with owner. Wait for your teammates instead of doing their tasks yourself.'
  return {
    task_create: `Add a task to your team's shared task list. Every teammate sees it, and a teammate claims it when it is free. A task with blocked_by waits until those tasks are completed. ${flow}`,
    task_list: `List your team's shared tasks: number, subject, state (pending, in_progress, completed), owner, and what blocks it. ${flow}`,
    task_get: "Read one task of your team's list in full, with its description.",
    task_update: `Change one task of your team's list: claim it (claim: true), set its state, assign or release it (owner), edit it, or add what blocks it. Mark a task completed only when its work is done; that unblocks the tasks that wait for it. ${flow}`,
  }
}

/** The extension, bound to the runtime that hosts it. */
export function teamTasks(host: TeamTasksHost): InlineExtension {
  return { name: 'kortix-team-tasks', factory: (pi) => register(pi, host) }
}

function register(pi: ExtensionAPI, host: TeamTasksHost): void {
  pi.on('session_start', () => {
    const text = descriptions(host.isTeammate())
    const tool = <P>(name: (typeof TEAM_TASK_TOOLS)[number], parameters: unknown, run: (params: P, signal?: AbortSignal) => Promise<MultiAgentToolResult>) =>
      pi.registerTool({
        name,
        label: name,
        description: text[name],
        parameters: parameters as never,
        executionMode: 'parallel' as const,
        execute: async (_id: string, params: P, signal: AbortSignal | undefined) => toolReturn(await run((params ?? {}) as P, signal)),
      })
    tool<CreateParams>('task_create', createParameters, (params, signal) => createTask(host, params, signal))
    tool<Record<string, never>>('task_list', listParameters, (_params, signal) => listTasks(host, signal))
    tool<{ seq: number }>('task_get', getParameters, (params, signal) => getTask(host, params.seq, signal))
    tool<UpdateParams>('task_update', updateParameters, (params, signal) => updateTask(host, params, signal))
  })
}

const NO_CONTROL_PLANE = { kind: 'failed' as const, message: 'This session has no Kortix control plane, so it has no team task list.' }

async function call(host: TeamTasksHost, method: 'GET' | 'POST' | 'PATCH', suffix: string, body?: unknown, signal?: AbortSignal): Promise<ApiAnswer | { unreachable: string } | null> {
  const plane = host.controlPlane()
  if (!plane) return null
  try {
    return await callApi(plane, method, sessionPath(plane.projectId, host.teamLead(), `/tasks${suffix}`), body, signal)
  } catch (err) {
    return { unreachable: `The Kortix API could not be reached: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function createTask(host: TeamTasksHost, params: CreateParams, signal?: AbortSignal): Promise<MultiAgentToolResult> {
  const subject = typeof params.subject === 'string' ? params.subject.trim() : ''
  if (!subject) return failure('task_create', 'create', 'No task added', { kind: 'invalid', message: 'A task needs a subject.' })
  const body: SessionTaskCreateBody = {
    subject,
    ...(params.description?.trim() ? { description: params.description.trim() } : {}),
    ...(params.blocked_by?.length ? { blocked_by: params.blocked_by } : {}),
    ...(params.owner?.trim() ? { owner: params.owner.trim().replace(/^@/, '') } : {}),
  }
  const answer = await call(host, 'POST', '', body, signal)
  if (!answer) return failure('task_create', 'create', 'No task added', NO_CONTROL_PLANE)
  if ('unreachable' in answer) return failure('task_create', 'create', 'No task added', { kind: 'failed', message: answer.unreachable })
  if (answer.status !== 201 && answer.status !== 200) return failure('task_create', 'create', 'No task added', { kind: errorKind(answer.status), message: apiErrorMessage(answer, 'The task was not added') })
  const task = answer.body as SessionTask
  return { ok: true, tool: 'task_create', action: 'create', card: { title: `Added task #${task.seq}: ${task.subject}`, status: 'done', rows: [taskRow(task)] }, data: task }
}

export async function listTasks(host: TeamTasksHost, signal?: AbortSignal): Promise<MultiAgentToolResult> {
  const answer = await call(host, 'GET', '', undefined, signal)
  if (!answer) return failure('task_list', 'list', 'No task list', NO_CONTROL_PLANE)
  if ('unreachable' in answer) return failure('task_list', 'list', 'Could not read the task list', { kind: 'failed', message: answer.unreachable })
  if (answer.status !== 200) return failure('task_list', 'list', 'Could not read the task list', { kind: errorKind(answer.status), message: apiErrorMessage(answer, 'The task list could not be read') })
  const tasks = ((answer.body as { tasks?: SessionTask[] } | null)?.tasks ?? []).slice().sort((a, b) => a.seq - b.seq)
  const count = (status: SessionTaskStatus) => tasks.filter((task) => task.status === status).length
  const open = tasks.filter((task) => task.status === 'pending' && !task.owner_session_id && !task.blocked).length
  return {
    ok: true,
    tool: 'task_list',
    action: 'list',
    card: {
      title: tasks.length === 0 ? 'No tasks yet' : `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`,
      ...(tasks.length ? { subtitle: `${count('completed')} done, ${count('in_progress')} in progress, ${count('pending')} to do${open ? ` (${open} free to claim)` : ''}.` } : {}),
      status: 'done',
      rows: tasks.map(taskRow),
    },
    data: { tasks },
  }
}

export async function getTask(host: TeamTasksHost, seq: number, signal?: AbortSignal): Promise<MultiAgentToolResult> {
  const listed = await listTasks(host, signal)
  if (!listed.ok) return { ...listed, tool: 'task_get', action: 'get' }
  const task = (listed.data as { tasks: SessionTask[] }).tasks.find((candidate) => candidate.seq === seq)
  if (!task) return failure('task_get', 'get', `No task #${seq}`, { kind: 'not_found', message: `The team has no task #${seq}. task_list shows the numbers.` })
  return { ok: true, tool: 'task_get', action: 'get', card: { title: `Task #${task.seq}: ${task.subject}`, ...(task.description ? { subtitle: task.description } : {}), status: 'done', rows: [taskRow(task)] }, data: task }
}

export async function updateTask(host: TeamTasksHost, params: UpdateParams, signal?: AbortSignal): Promise<MultiAgentToolResult> {
  const seq = params.seq
  const action = params.claim ? 'claim' : params.status ? params.status : 'update'
  if (!Number.isInteger(seq) || seq < 1) return failure('task_update', action, 'No task changed', { kind: 'invalid', message: 'Name the task by its number in seq.' })
  const { seq: _seq, ...rest } = params
  const body: SessionTaskUpdateBody = {
    ...(rest.claim ? { claim: true } : {}),
    ...(rest.status ? { status: rest.status } : {}),
    ...(rest.owner === null ? { owner: null } : typeof rest.owner === 'string' && rest.owner.trim() ? { owner: rest.owner.trim().replace(/^@/, '') } : {}),
    ...(rest.subject?.trim() ? { subject: rest.subject.trim() } : {}),
    ...(rest.description !== undefined ? { description: rest.description } : {}),
    ...(rest.add_blocked_by?.length ? { add_blocked_by: rest.add_blocked_by } : {}),
  }
  if (Object.keys(body).length === 0) return failure('task_update', action, `Task #${seq} unchanged`, { kind: 'invalid', message: 'Say what changes: claim, status, owner, subject, description or add_blocked_by.' })
  const answer = await call(host, 'PATCH', `/${seq}`, body, signal)
  if (!answer) return failure('task_update', action, `Task #${seq} unchanged`, NO_CONTROL_PLANE)
  if ('unreachable' in answer) return failure('task_update', action, `Task #${seq} unchanged`, { kind: 'failed', message: answer.unreachable })
  if (answer.status === 409) {
    const code = (answer.body as { code?: string } | null)?.code
    const message =
      code === SESSION_TASK_TAKEN_CODE
        ? `Task #${seq} is already taken or no longer pending. Run task_list and claim another free task.`
        : code === SESSION_TASK_BLOCKED_CODE
          ? `Task #${seq} waits for tasks that are not completed yet. Claim a free task instead.`
          : apiErrorMessage(answer, `Task #${seq} could not change`)
    return { ...failure('task_update', action, code === SESSION_TASK_TAKEN_CODE ? `Task #${seq} is taken` : code === SESSION_TASK_BLOCKED_CODE ? `Task #${seq} is blocked` : `Task #${seq} unchanged`, { kind: 'invalid', message }), data: answer.body }
  }
  if (answer.status !== 200) return failure('task_update', action, `Task #${seq} unchanged`, { kind: errorKind(answer.status), message: apiErrorMessage(answer, `Task #${seq} could not change`) })
  const task = answer.body as SessionTask
  const title = params.claim
    ? `Claimed task #${task.seq}: ${task.subject}`
    : task.status === 'completed' && params.status === 'completed'
      ? `Completed task #${task.seq}: ${task.subject}`
      : `Updated task #${task.seq}: ${task.subject}`
  return { ok: true, tool: 'task_update', action, card: { title, status: 'done', rows: [taskRow(task)] }, data: task }
}

const STATUS_BADGE: Record<SessionTaskStatus, string> = { pending: 'to do', in_progress: 'in progress', completed: 'done' }

function taskRow(task: SessionTask): KortixCardRow {
  const detail = [task.owner_handle ? `owner ${task.owner_handle}` : 'no owner', task.blocked ? `waits for ${task.blocked_by.map((n) => `#${n}`).join(', ')}` : null].filter(Boolean)
  return { title: `#${task.seq} ${task.subject}`, detail: detail.join(' · '), badge: task.blocked && task.status === 'pending' ? 'blocked' : STATUS_BADGE[task.status] }
}
