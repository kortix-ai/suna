import { spawn } from 'node:child_process'
import { accessSync, appendFileSync, closeSync, constants, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { enabledFeatureFlags } from '@/lib/config/feature-flags'
import { logger } from '@/lib/log/logger'

/**
 * After every turn end that apps/api settled, for every harness, the daemon
 * runs up to two commands, detached and best effort (their exit codes and
 * output never touch the turn):
 *
 * 1. the session's own hook, an executable the agent installs at
 *    `~/.kortix/hooks/on-idle`, with the turn's status in the env. A hook that
 *    wants another turn queues one itself (`kortix sessions chat
 *    "$KORTIX_SESSION_ID" -p … --queue`);
 * 2. in a box whose project has the `goals` flag (KORTIX_FEATURE_FLAGS), the
 *    goal check `kortix goals check --enforce --quiet`, always, also when a
 *    custom hook exists. The CLI asks the Goals API which goals this session
 *    owns, so no file is parsed here; a session that owns none exits 0. The
 *    check is idempotent per turn: it reads KORTIX_TURN_MESSAGE_ID.
 *
 * Each command's output and its exit code go to the log file (owner-only:
 * the output can carry secrets).
 */
export const ON_IDLE_HOOK = join(homedir(), '.kortix', 'hooks', 'on-idle')
export const GOAL_CHECK_COMMAND = 'kortix goals check --enforce --quiet'
export const ON_IDLE_LOG = '/tmp/kortix-on-idle.log'

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function logLine(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} [on-idle] ${line}\n`, { mode: 0o600 })
  } catch {}
}

/** Starts the turn-end commands; returns the commands it started (empty: none). */
export function runOnIdleHook(
  turn: { status: 'idle' | 'error'; messageId: string | null },
  opts: { path?: string; logPath?: string; env?: NodeJS.ProcessEnv; goalCheckCommand?: string } = {},
): string[] {
  const path = opts.path ?? ON_IDLE_HOOK
  const logPath = opts.logPath ?? ON_IDLE_LOG
  const env = opts.env ?? process.env
  const commands: Array<{ name: string; command: string }> = []
  if (isExecutable(path)) commands.push({ name: 'hook', command: JSON.stringify(path) })
  if (enabledFeatureFlags(env).has('goals')) commands.push({ name: 'goal check', command: opts.goalCheckCommand ?? GOAL_CHECK_COMMAND })
  for (const { name, command } of commands) start(name, command, turn, logPath, env)
  return commands.map((c) => c.command)
}

function start(name: string, command: string, turn: { status: 'idle' | 'error'; messageId: string | null }, logPath: string, env: NodeJS.ProcessEnv): void {
  let output: number | 'ignore' = 'ignore'
  try {
    output = openSync(logPath, 'a', 0o600)
  } catch {}
  try {
    // A login shell, so the command sees the agent's environment (the kortix CLI, its token).
    const child = spawn('bash', ['-lc', command], {
      env: { ...process.env, ...env, KORTIX_TURN_STATUS: turn.status, KORTIX_TURN_MESSAGE_ID: turn.messageId ?? '' },
      detached: true,
      stdio: ['ignore', output, output],
    })
    child.on('error', (err) => {
      logLine(logPath, `${name} failed to start: ${(err as Error).message}`)
      logger.warn('[on-idle] command failed to spawn', { name, err: (err as Error).message })
    })
    child.on('exit', (code, signal) => {
      if (code === 0) return
      const why = signal ? `signal ${signal}` : `exit code ${code}`
      logLine(logPath, `${name} failed (${why}) for turn ${turn.messageId ?? '(none)'}: ${command}`)
      logger.warn('[on-idle] command failed', { name, code, signal, turnMessageId: turn.messageId })
    })
    child.unref()
  } finally {
    if (typeof output === 'number') closeSync(output)
  }
}
