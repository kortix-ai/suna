import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/lib/log/logger'

/**
 * A session's own turn-end hook: an executable the agent installs at
 * `~/.kortix/hooks/on-idle`. The daemon runs it after every turn end that
 * apps/api settled, for every harness, with the turn's status in the env.
 * It runs detached and best effort: its exit code and output never touch the
 * turn. A hook that wants another turn queues one itself (`kortix sessions
 * chat "$KORTIX_SESSION_ID" -p … --queue`).
 *
 * Without a hook, a session that coordinates a goal (a goal.json under
 * /drives/<folder>/Goals/<slug>/ listing it as coordinator) runs
 * `kortix goals check --enforce --quiet` instead: live runs showed the model
 * skips installing the hook, so the check does not depend on it.
 */
export const ON_IDLE_HOOK = join(homedir(), '.kortix', 'hooks', 'on-idle')
export const GOAL_CHECK_COMMAND = 'kortix goals check --enforce --quiet'

/** True when a goal under `drivesRoot` names `sessionId` as its coordinator. */
export function coordinatesGoal(sessionId: string | undefined, drivesRoot = '/drives'): boolean {
  if (!sessionId || !existsSync(drivesRoot)) return false
  try {
    for (const mount of readdirSync(drivesRoot)) {
      const goals = join(drivesRoot, mount, 'Goals')
      if (!existsSync(goals)) continue
      for (const slug of readdirSync(goals)) {
        try {
          const g = JSON.parse(readFileSync(join(goals, slug, 'goal.json'), 'utf8')) as { sessions?: Array<{ id?: string; role?: string }> }
          if (g.sessions?.some((s) => s.id === sessionId && s.role === 'coordinator')) return true
        } catch {}
      }
    }
  } catch {}
  return false
}

export function runOnIdleHook(
  turn: { status: 'idle' | 'error'; messageId: string | null },
  opts: { path?: string; logPath?: string; drivesRoot?: string; sessionId?: string } = {},
): boolean {
  const path = opts.path ?? ON_IDLE_HOOK
  let command: string
  try {
    accessSync(path, constants.X_OK)
    command = JSON.stringify(path)
  } catch {
    if (!coordinatesGoal(opts.sessionId ?? process.env.KORTIX_SESSION_ID, opts.drivesRoot)) return false
    command = GOAL_CHECK_COMMAND
  }
  let output: number | 'ignore' = 'ignore'
  try {
    // Owner-only, like on_boot's log: the hook's output can carry secrets.
    output = openSync(opts.logPath ?? '/tmp/kortix-on-idle.log', 'a', 0o600)
  } catch {}
  try {
    // A login shell, so the hook sees the agent's environment (the kortix CLI, its token).
    const child = spawn('bash', ['-lc', command], {
      env: { ...process.env, KORTIX_TURN_STATUS: turn.status, KORTIX_TURN_MESSAGE_ID: turn.messageId ?? '' },
      detached: true,
      stdio: ['ignore', output, output],
    })
    child.on('error', (err) => logger.warn('[on-idle] hook failed to spawn', { err: (err as Error).message }))
    child.unref()
  } finally {
    if (typeof output === 'number') closeSync(output)
  }
  return true
}
