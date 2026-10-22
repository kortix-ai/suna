/**
 * The pre-W3 (OpenCode-era) names of kortixd's wire fields, and the only
 * module outside `harness/open-code/` that still spells them.
 *
 * An API deploy built before W3 reads and sends these names, and a box keeps
 * its daemon across API deploys and rollbacks, so the routes answer in both
 * spellings. Every other daemon module uses the Kortix names.
 *
 * Delete this file, its callers' spreads, and its `OPENCODE_NAMES_ALLOWED`
 * entry in eslint.config.mjs once no API deploy older than W3 can run.
 */
import type { HarnessHealth } from '@kortix/api-contract/runtime-relay'
import type { HarnessEnvironmentResult, HarnessRefreshResult } from '@/harness/contract/control'
import type { RunningRuntimeAssets } from '@/services/runtime-assets/runtime-assets'

/** The Runtime API's pre-W3 mount: `/kortix/opencode/*`. */
export const LEGACY_RUNTIME_MOUNT = '/opencode'

/** `POST /kortix/env` request: `opencodeEnv` is the pre-W3 `runtimeEnv`. */
export function legacyRuntimeEnv(body: object): unknown {
  return (body as { opencodeEnv?: unknown }).opencodeEnv
}

/** `POST /kortix/abort/after-tool` request: `opencode_session_id` is the pre-W3 `runtime_session_id`. */
export function legacyRuntimeSessionId(body: Record<string, unknown> | null): unknown {
  return body?.opencode_session_id
}

/** `POST /kortix/abort` response. */
export function legacyAbortFields(runtimeSessionId: string): Record<string, string> {
  return { opencode_session_id: runtimeSessionId }
}

/** `POST /kortix/env` response. */
export function legacyEnvFields(result: HarnessEnvironmentResult): Record<string, unknown> {
  return {
    opencode_env_changed: result.runtime_env_changed,
    opencode_env_names: result.runtime_env_names,
    opencode: result.runtime,
    opencode_pid: result.runtime_pid,
    opencode_reload: result.runtime_reload,
    opencode_turn_ended: result.runtime_turn_ended,
  }
}

/** `POST /kortix/refresh` response. */
export function legacyRefreshFields(result: HarnessRefreshResult): Record<string, unknown> {
  return { opencode: result.runtime, opencode_pid: result.runtime_pid }
}

/** `GET /kortix/health`: the flat fields the `harness` block replaced. */
export function legacyHealthFields(harness: HarnessHealth): Record<string, unknown> {
  const { pid, port } = harness.details
  return {
    opencode: harness.state,
    opencode_pid: typeof pid === 'number' ? pid : null,
    // The API's PTY proxy dials OpenCode's live port (it alternates on a verified reload).
    opencode_port: typeof port === 'number' ? port : null,
    opencode_session_id: harness.session.id,
    opencode_session_required: harness.session.required,
  }
}

/** `GET /kortix/health` `runtime.running`: `opencode_version` was OpenCode's release on disk. */
export function legacyRunningFields(running: Pick<RunningRuntimeAssets, 'harness' | 'harness_version'>): Record<string, unknown> {
  return { opencode_version: running.harness === 'opencode' ? running.harness_version : null }
}
