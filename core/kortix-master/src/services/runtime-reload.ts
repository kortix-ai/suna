/**
 * Runtime Reload — Nuclear restart for the entire Kortix stack.
 *
 * Two modes:
 *   - "dispose-only": Hot-reload OpenCode config (agents, skills, commands, opencode.jsonc).
 *     Does NOT reload .ts plugin code (module cache persists). Fast (~2s).
 *
 *   - "full": Kill and restart EVERY process that holds code.
 *     Restarts all s6 services. Guarantees fresh module caches.
 *     Takes ~5-10s. All active sessions will be interrupted.
 *
 * s6 services (from Dockerfile / core/s6-services/):
 *   svc-opencode-serve     — OpenCode runtime (port 4096, plugins, agents, tools, web UI)
 *   svc-static-web         — Static file server (port 3211)
 *   svc-lss-sync           — Local semantic search indexer
 *   svc-kortix-master      — This process (port 8000)
 */

import { config } from '../config'

export type ReloadMode = 'dispose-only' | 'full'

export interface ReloadResult {
  success: boolean
  mode: ReloadMode
  steps: string[]
  errors: string[]
}

interface SessionStatusLike {
  type?: string
}

export function getBusySessionIds(statuses?: Record<string, SessionStatusLike> | null): string[] {
  if (!statuses) return []
  return Object.entries(statuses)
    .filter(([sessionId, status]) => Boolean(sessionId) && !!status && status.type !== 'idle')
    .map(([sessionId]) => sessionId)
}

async function cancelActiveSessionsBeforeShutdown(result: ReloadResult): Promise<void> {
  const baseUrl = `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`

  let busySessionIds: string[] = []
  try {
    const res = await fetch(`${baseUrl}/session/status`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const statuses = (await res.json()) as Record<string, SessionStatusLike>
    busySessionIds = getBusySessionIds(statuses)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`Could not inspect active sessions before shutdown: ${msg}`)
    return
  }

  if (busySessionIds.length === 0) {
    result.steps.push('No active sessions needed cancellation before shutdown')
    return
  }

  result.steps.push(`Cancelling ${busySessionIds.length} active session(s) before shutdown`)

  const failures: string[] = []
  await Promise.all(
    busySessionIds.map(async (sessionId) => {
      try {
        const res = await fetch(`${baseUrl}/session/${sessionId}/abort`, {
          method: 'POST',
          signal: AbortSignal.timeout(5_000),
        })
        if (!res.ok && res.status !== 404) {
          const body = await res.text().catch(() => '')
          throw new Error(body ? `HTTP ${res.status}: ${body.slice(0, 200)}` : `HTTP ${res.status}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${sessionId}: ${msg}`)
      }
    }),
  )

  const cancelledCount = busySessionIds.length - failures.length
  if (cancelledCount > 0) {
    result.steps.push(`Cancelled ${cancelledCount} active session(s) before shutdown`)
    await Bun.sleep(250)
  }

  if (failures.length > 0) {
    result.errors.push(`Failed to cancel ${failures.length} active session(s): ${failures.join('; ')}`)
  }
}

export function getSafeFullReloadFallback(options?: {
  envMode?: string
  uid?: number
}): string | null {
  const envMode = (options?.envMode || process.env.ENV_MODE || 'local').toLowerCase()
  const uid = options?.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)

  if (envMode === 'local' && uid !== 0) {
    return 'Full restart is not supported from the local sandbox app process; performed a safe OpenCode dispose instead to avoid a kortix-master restart loop'
  }

  return null
}

interface S6RunResult {
  ok: boolean
  exitCode: number
  command: string
  stderr: string
}

function decodeOutput(bytes?: Uint8Array | null): string {
  if (!bytes || bytes.length === 0) return ''
  return Buffer.from(bytes).toString('utf8').trim()
}

function runS6Svc(args: string[]): S6RunResult {
  const candidates: string[][] = [
    ['sudo', '-n', 's6-svc', ...args],
    ['s6-svc', ...args],
  ]

  let last: S6RunResult = {
    ok: false,
    exitCode: -1,
    command: candidates[0].join(' '),
    stderr: 's6-svc unavailable',
  }

  for (const cmd of candidates) {
    try {
      const proc = Bun.spawnSync(cmd, {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stderr = decodeOutput(proc.stderr)
      const exitCode = proc.exitCode ?? -1
      const result: S6RunResult = {
        ok: exitCode === 0,
        exitCode,
        command: cmd.join(' '),
        stderr,
      }
      if (result.ok) return result
      last = result
    } catch (err) {
      last = {
        ok: false,
        exitCode: -1,
        command: cmd.join(' '),
        stderr: err instanceof Error ? err.message : String(err),
      }
    }
  }

  return last
}

/**
 * Dispose the OpenCode instance — hot-reload config from disk.
 * Reloads: agents, skills, commands, opencode.jsonc, MCP connections.
 * Does NOT reload: .ts plugin code (module cache persists in the process).
 */
async function disposeOpenCode(result: ReloadResult): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:4096/instance/dispose', {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    })
    await res.arrayBuffer().catch(() => {})
    result.steps.push('OpenCode disposed — agents, skills, commands reloaded from disk')
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`OpenCode dispose failed: ${msg}`)
    return false
  }
}

/**
 * Restart an s6 service. s6-svc -r sends SIGTERM, waits for exit, restarts.
 * Returns immediately — s6 handles the lifecycle.
 */
function restartS6(svcName: string, result: ReloadResult): void {
  const res = runS6Svc(['-r', `/run/service/${svcName}`])
  if (res.ok) {
    result.steps.push(`Restarted ${svcName}`)
    return
  }

  // exit 111 = supervisor not running (service doesn't exist in this environment)
  if (res.exitCode === 111) {
    result.steps.push(`${svcName}: skipped (exit 111)`)
    return
  }

  result.errors.push(`${svcName} restart failed via '${res.command}': ${res.stderr || `exit ${res.exitCode}`}`)
}

export async function initiateRuntimeReload(mode: ReloadMode): Promise<ReloadResult> {
  const result: ReloadResult = {
    success: true,
    mode,
    steps: [],
    errors: [],
  }

  await cancelActiveSessionsBeforeShutdown(result)

  // ── dispose-only: hot-reload config without killing processes ──
  if (mode === 'dispose-only') {
    const ok = await disposeOpenCode(result)
    result.success = ok
    if (ok) result.steps.push('Note: .ts plugin code changes need Full Restart')
    return result
  }

  const safeFallbackReason = getSafeFullReloadFallback()
  if (safeFallbackReason) {
    const ok = await disposeOpenCode(result)
    result.success = ok
    result.steps.push(safeFallbackReason)
    if (!ok) result.errors.push('Safe fallback reload failed')
    return result
  }

  // ── full: kill and restart every code-holding process ──
  // s6-svc -r = SIGTERM → wait for exit → restart fresh (clean module cache)
  result.steps.push('Full restart: restarting all code-holding services via s6')

  restartS6('svc-opencode-serve', result)     // port 4096 — plugins, agents, tools
  restartS6('svc-static-web', result)         // port 3211 — static file server
  restartS6('svc-lss-sync', result)           // semantic search indexer

  result.steps.push('Restarting kortix-master last — s6 will respawn with fresh state')
  result.success = true

  // Self-restart — deferred so HTTP response goes out first
  setTimeout(() => {
    console.log('[runtime-reload] Full restart: killing kortix-master — s6 will respawn')

    const restart = runS6Svc(['-r', '/run/service/svc-kortix-master'])
    if (!restart.ok) {
      console.warn(`[runtime-reload] Failed to restart svc-kortix-master via '${restart.command}': ${restart.stderr || `exit ${restart.exitCode}`}`)
      // Fallback hard exit so s6 still respawns us even if the privileged helper
      // is unavailable in this environment.
      setTimeout(() => process.exit(0), 3000)
      return
    }

    // Safety valve: if s6 accepted the restart but for some reason this process
    // was not terminated, exit anyway so the supervisor can bring up a clean copy.
    setTimeout(() => process.exit(0), 5000)
  }, 300)

  return result
}
