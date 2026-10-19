import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/lib/log/logger'

/**
 * A session's own turn-end hook: an executable the agent installs at
 * `~/.kortix/hooks/on-idle`. The daemon runs it after every turn end that
 * apps/api settled, for every harness, with the turn's status in the env.
 * It runs detached and best effort: its exit code and output never touch the
 * turn. A hook that wants another turn queues one itself (`kortix sessions
 * chat "$KORTIX_SESSION_ID" -p … --queue`). `kortix goals check --enforce`
 * is the hook a goal installs.
 */
export const ON_IDLE_HOOK = join(homedir(), '.kortix', 'hooks', 'on-idle')

export function runOnIdleHook(
  turn: { status: 'idle' | 'error'; messageId: string | null },
  opts: { path?: string; logPath?: string } = {},
): boolean {
  const path = opts.path ?? ON_IDLE_HOOK
  try {
    accessSync(path, constants.X_OK)
  } catch {
    return false
  }
  let output: number | 'ignore' = 'ignore'
  try {
    // Owner-only, like on_boot's log: the hook's output can carry secrets.
    output = openSync(opts.logPath ?? '/tmp/kortix-on-idle.log', 'a', 0o600)
  } catch {}
  try {
    // A login shell, so the hook sees the agent's environment (the kortix CLI, its token).
    const child = spawn('bash', ['-lc', JSON.stringify(path)], {
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
