import { Hono } from 'hono'
import type { HarnessDiagnosticsContext, HarnessDiagnosticsService } from '@/harness/contract/diagnostics'
import { readHostHealth } from '@/harness/shared/host-health'
import { legacyHealthFields, legacyRunningFields } from './legacy-names'

/**
 * `GET /kortix/health`: the host facts, the selected harness's closed `harness`
 * block (E19), and the one readiness verdict computed from both. Daemon
 * liveness stays HTTP 200 even when the runtime is unavailable.
 */
export function createHealthRouter(
  context: HarnessDiagnosticsContext,
  diagnostics: HarnessDiagnosticsService,
  /** Control-owned capabilities, e.g. `config.release.v1` when the control converges config releases. */
  controlCapabilities: readonly string[] = [],
): Hono {
  const router = new Hono()
  router.get('/', async (c) => {
    const turn = c.req.query('turn') === '1'
      ? {
          sessionId: c.req.query('turn_session_id')?.trim(),
          messageId: c.req.query('turn_message_id')?.trim(),
        }
      : undefined
    const [host, report] = await Promise.all([
      readHostHealth(context, diagnostics.catalogSnapshot),
      diagnostics.health(context, { turn }),
    ])
    const { running } = host.runtime
    const harness = {
      ...report.harness,
      // The runtime-assets record names the release on disk when the adapter cannot tell.
      version: report.harness.version ?? (running.harness === report.harness.id ? running.harness_version : null),
    }
    const repoError = context.bootState.repoMaterializationError
    const runtimeReady = host.repo_ready && !repoError && harness.ready
    return c.json({
      daemon: 'ok',
      // Host-owned `/file` routes for every harness, then what the control and
      // the runtime serve.
      capabilities: ['file.import', 'file.append', ...controlCapabilities, ...diagnostics.capabilities],
      status: runtimeReady ? 'ok' : repoError || harness.error ? 'error' : harness.state,
      runtimeReady,
      boot_error: repoError ?? harness.error,
      ...host,
      runtime: { ...host.runtime, running: { ...running, ...legacyRunningFields(running) } },
      harness,
      ...(report.config ? { config: report.config } : {}),
      ...(report.configDirSha !== undefined ? { config_dir_sha: report.configDirSha } : {}),
      // Opt-in (`?turn=1`); flat because the reload gate and the reaper read them there.
      ...(harness.turn
        ? {
            turn_in_flight: harness.turn.in_flight,
            turn_end: harness.turn.end,
            turn_orphaned_prompt: harness.turn.orphaned_prompt,
          }
        : {}),
      ...legacyHealthFields(harness),
    })
  })
  return router
}
