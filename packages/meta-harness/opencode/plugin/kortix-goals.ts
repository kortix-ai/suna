import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

import {
  addTask,
  createGoal,
  decideGoalLoop,
  findGoal,
  GOAL_STATUSES,
  goalFilePath,
  readGoalFile,
  renderGoal,
  renderGoalContext,
  setGoalStatus,
  TASK_STATUSES,
  updateTask,
  writeGoalFile,
} from '../lib/goals'

// ─────────────────────────────────────────────────────────────────────────────
// Kortix goals — the harness half of "keep working until it is truly done".
//
//   tools   goal_create / goal_task / goal_update / goal_wake / goal_list
//   loop    on `session.idle`, an active goal gets a continuation prompt
//   memory  every turn's system prompt carries the live goal board, and
//           compaction keeps it, so a reset context restarts from the truth
//
// The rules live in ../lib/goals.ts (pure, tested). This file is transport.
// Kill switch: KORTIX_GOAL_LOOP=0 disables the continuation (tools stay).
// ─────────────────────────────────────────────────────────────────────────────

const SETTLE_MS = 2_500

export const KortixGoals: Plugin = async ({ client }) => {
  const path = goalFilePath()
  const toolCalls = new Map<string, number>()
  const aborted = new Set<string>()
  const errored = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()

  const loopEnabled = () => (process.env.KORTIX_GOAL_LOOP ?? '1').trim() !== '0'
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  async function sessionBusy(sessionId: string): Promise<boolean> {
    try {
      const res = await client.session.status()
      const type = (res.data as Record<string, { type?: string } | undefined> | undefined)?.[sessionId]?.type
      return type === 'busy' || type === 'retry'
    } catch {
      // Unknown is not idle: never prompt into a session we cannot read.
      return true
    }
  }

  async function onIdle(sessionId: string): Promise<void> {
    if (!loopEnabled() || running.has(sessionId)) return
    const turn = {
      aborted: aborted.has(sessionId),
      errored: errored.has(sessionId),
      toolCalls: toolCalls.get(sessionId) ?? 0,
    }
    aborted.delete(sessionId)
    errored.delete(sessionId)
    toolCalls.set(sessionId, 0)
    if (!readGoalFile(path).goals.some((g) => g.session_id === sessionId && g.status === 'active')) return

    running.add(sessionId)
    try {
      // A queued user prompt is delivered right after the turn ends; it wins.
      await sleep(SETTLE_MS)
      if (await sessionBusy(sessionId)) return
      const file = readGoalFile(path)
      const decision = decideGoalLoop(file, sessionId, turn, new Date())
      if (decision.action === 'none') return
      if (decision.action === 'schedule') {
        const existing = timers.get(sessionId)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          timers.delete(sessionId)
          // A timer wake is a fresh check, not an empty turn.
          toolCalls.set(sessionId, 1)
          void onIdle(sessionId)
        }, Math.max(1_000, decision.wakeAt.getTime() - Date.now()))
        timers.set(sessionId, timer)
        return
      }
      writeGoalFile(path, file)
      if (decision.action === 'paused') return
      if (await sessionBusy(sessionId)) return
      await client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: decision.prompt }] },
      })
    } catch (error) {
      console.error('[kortix-goals] continuation failed', error)
    } finally {
      running.delete(sessionId)
    }
  }

  function mutate<T>(sessionId: string, fn: (file: ReturnType<typeof readGoalFile>) => { ok: true; value: T } | { ok: false; error: string }): { ok: true; value: T } | { ok: false; error: string } {
    const file = readGoalFile(path)
    const result = fn(file)
    if (result.ok) writeGoalFile(path, file)
    return result
  }

  const fail = (error: string) => `Error: ${error}`

  return {
    event: async ({ event }) => {
      const props = (event as { properties?: { sessionID?: string; error?: { name?: string } } }).properties
      const sessionId = props?.sessionID
      if (!sessionId) return
      if (event.type === 'session.error') {
        if (props?.error?.name === 'MessageAbortedError') aborted.add(sessionId)
        else errored.add(sessionId)
      }
      if (event.type === 'session.idle') void onIdle(sessionId)
    },

    'tool.execute.after': async (input) => {
      toolCalls.set(input.sessionID, (toolCalls.get(input.sessionID) ?? 0) + 1)
    },

    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return
      const context = renderGoalContext(
        readGoalFile(path).goals.filter((g) => g.session_id === input.sessionID),
      )
      if (context) output.system.push(context)
    },

    'experimental.session.compacting': async (input, output) => {
      const context = renderGoalContext(
        readGoalFile(path).goals.filter((g) => g.session_id === input.sessionID),
      )
      if (context) output.context.push(context)
    },

    tool: {
      goal_create: tool({
        description:
          'Create a long-running goal. The harness keeps you working on it after every turn until it is complete, ' +
          'blocked, or waiting on the user. Use it for work that takes many steps or a long time.',
        args: {
          title: tool.schema.string().describe('Short name, under 80 characters.'),
          objective: tool.schema.string().describe('The outcome, stated so someone else could check it.'),
          acceptance: tool.schema
            .array(tool.schema.string())
            .describe('Checkable criteria. Completion needs evidence for each.'),
          max_continuations: tool.schema
            .number()
            .int()
            .min(1)
            .max(10_000)
            .optional()
            .describe('Upper bound on harness continuations. Default 200.'),
        },
        async execute(args, context) {
          const result = mutate(context.sessionID, (file) =>
            createGoal(file, {
              sessionId: context.sessionID,
              title: args.title,
              objective: args.objective,
              acceptance: args.acceptance,
              maxContinuations: args.max_continuations,
              now: new Date(),
            }),
          )
          if (!result.ok) return fail(result.error)
          return `Created goal ${result.value.id}. Plan it now with goal_task, then start the first step.\n\n${renderGoal(result.value)}`
        },
      }),

      goal_task: tool({
        description:
          'Add a task to a goal board, or update one (status, evidence, the worker session doing it). ' +
          'A done task needs evidence.',
        args: {
          goal_id: tool.schema.string(),
          add: tool.schema.string().optional().describe('Title of a new task.'),
          task_id: tool.schema.string().optional().describe('Task to update, e.g. t2.'),
          status: tool.schema.enum(TASK_STATUSES).optional(),
          evidence: tool.schema.string().optional().describe('Paths, links, commits, or the check you ran.'),
          session_id: tool.schema.string().optional().describe('The worker session doing the task.'),
        },
        async execute(args, context) {
          const now = new Date()
          const result = mutate(context.sessionID, (file) => {
            const found = findGoal(file, context.sessionID, args.goal_id)
            if (!found.ok) return found
            if (args.add) return addTask(found.value, { title: args.add, now })
            if (!args.task_id) return { ok: false as const, error: 'give add (a new task) or task_id (an update)' }
            return updateTask(found.value, {
              taskId: args.task_id,
              status: args.status,
              evidence: args.evidence,
              sessionId: args.session_id,
              now,
            })
          })
          if (!result.ok) return fail(result.error)
          return `${result.value.id} [${result.value.status}] ${result.value.title}`
        },
      }),

      goal_update: tool({
        description:
          'Change a goal status. complete needs one evidence item per acceptance criterion. waiting needs the ' +
          'question for the user; blocked needs the blocker. active resumes a paused, blocked or waiting goal ' +
          'when the user asks you to continue. cancelled ends it for good.',
        args: {
          goal_id: tool.schema.string(),
          status: tool.schema.enum(GOAL_STATUSES),
          evidence: tool.schema.array(tool.schema.string()).optional(),
          reason: tool.schema.string().optional().describe('The question (waiting) or the blocker (blocked).'),
        },
        async execute(args, context) {
          const result = mutate(context.sessionID, (file) => {
            const found = findGoal(file, context.sessionID, args.goal_id)
            if (!found.ok) return found
            return setGoalStatus(found.value, {
              status: args.status,
              evidence: args.evidence,
              reason: args.reason,
              now: new Date(),
            })
          })
          if (!result.ok) return fail(result.error)
          return `Goal ${result.value.id} is ${result.value.status}.`
        },
      }),

      goal_wake: tool({
        description:
          'Schedule your next check of a goal when you are waiting on workers or on time. The harness does not ' +
          'continue the goal before then. End your turn after calling it.',
        args: {
          goal_id: tool.schema.string(),
          minutes: tool.schema.number().min(1).max(24 * 60),
        },
        async execute(args, context) {
          const at = new Date(Date.now() + args.minutes * 60_000)
          const result = mutate(context.sessionID, (file) => {
            const found = findGoal(file, context.sessionID, args.goal_id)
            if (!found.ok) return found
            found.value.next_wake_at = at.toISOString()
            return found
          })
          if (!result.ok) return fail(result.error)
          return `Next check of ${args.goal_id} at ${at.toISOString()}. End your turn now.`
        },
      }),

      goal_list: tool({
        description: 'Show every goal of this session with its task board.',
        args: {},
        async execute(_args, context) {
          const goals = readGoalFile(path).goals.filter((g) => g.session_id === context.sessionID)
          if (goals.length === 0) return 'No goals in this session.'
          return goals.map(renderGoal).join('\n\n')
        },
      }),
    },
  }
}
