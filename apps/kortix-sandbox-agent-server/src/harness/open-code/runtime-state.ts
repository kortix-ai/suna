import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '@/lib/log/logger'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'

// The state directory is a host concern (every harness pins under it); the
// OpenCode pin paths below are native. Re-exported for the existing importers.
export { DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY, resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'

export function resolveOpenCodeAuditSpoolPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.KORTIX_AUDIT_SPOOL_PATH?.trim() ||
    join(resolveKortixRuntimeStateDirectory(env), 'opencode-audit-spool.json')
  )
}

/**
 * The pin paths resolve on every call, never at import. `KORTIX_RUNTIME_STATE_DIR`
 * has no production writer, so the answer is stable in a box; resolving per call
 * keeps a module import from freezing whichever directory was current first.
 */
export function openCodeSessionPinPath(): string {
  return join(resolveKortixRuntimeStateDirectory(), 'opencode-session-id')
}

export function openCodeSeedBakedPinPath(): string {
  return join(resolveKortixRuntimeStateDirectory(), 'opencode-seed-baked-id')
}

const OPENCODE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The one shape an OpenCode session id may have, enforced on BOTH sides of the
 * pin file. The writers below reject a malformed id before it lands on disk;
 * `readOpenCodeSessionPin` rejects one on the way back out.
 *
 * Read-side validation is not redundant. The pin lives at
 * `/home/kortix/.local/state/kortix/opencode-session-id`, owned by the same
 * `kortix` user the agent's own shell tools run as, so the file is writable by
 * something other than these writers. Validating on read keeps every consumer
 * of the pin — the abort URL in control.ts, relay, turn-end — working on an id
 * that matches this pattern, instead of trusting whatever the file holds.
 */
function isValidOpenCodeSessionId(value: string): boolean {
  return OPENCODE_SESSION_ID.test(value)
}

function validatedOpenCodeSessionId(value: string): string {
  if (!isValidOpenCodeSessionId(value)) {
    throw new Error('refusing to persist a malformed OpenCode session id')
  }
  return value
}

function ensurePrivateRuntimeStateDirectory(path: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
}

function writePrivatePin(path: string, sessionId: string): void {
  const validatedSessionId = validatedOpenCodeSessionId(sessionId)
  ensurePrivateRuntimeStateDirectory(path)
  writeFileSync(path, validatedSessionId, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

export function writeOpenCodeSessionPin(sessionId: string): void {
  writePrivatePin(openCodeSessionPinPath(), sessionId)
}

/**
 * Read the session pin, or null when there is no usable one. A pin that fails
 * `isValidOpenCodeSessionId` reads as absent — see that function for why the
 * read side validates too. Callers treat null as "no session pinned", so a
 * rejected pin degrades to creating a fresh session, never to a bad request.
 */
export function readOpenCodeSessionPin(): string | null {
  try {
    const path = openCodeSessionPinPath()
    if (!existsSync(path)) return null
    const id = readFileSync(path, 'utf8').trim()
    if (isValidOpenCodeSessionId(id)) return id
    if (id.length > 0) logger.warn('[runtime-state] ignoring a malformed pinned session id')
    return null
  } catch {
    return null
  }
}

export function writeOpenCodeSeedBakedPin(sessionId: string): void {
  writePrivatePin(openCodeSeedBakedPinPath(), sessionId)
}

/**
 * A daemon built before W3 spooled audit events with `opencode_session_id`.
 * The shared relay (`harness/shared/audit-relay.ts`) reads `runtime_session_id`
 * and refuses a spool with any other field, which would mark the runtime
 * unhealthy after a daemon update. Rename the field in place, before the relay
 * loads the spool. Remove once every box has run a W3 daemon.
 */
export function migratePreW3AuditSpool(path: string): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  if (!text.includes('"opencode_session_id"')) return
  const rename = (event: unknown): unknown => {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !('opencode_session_id' in event)) return event
    const { opencode_session_id: id, ...rest } = event as Record<string, unknown>
    return { ...rest, runtime_session_id: id }
  }
  const parsed: unknown = JSON.parse(text)
  const next = Array.isArray(parsed)
    ? parsed.map(rename)
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { queue?: unknown }).queue)
      ? { ...(parsed as object), queue: (parsed as { queue: unknown[] }).queue.map(rename) }
      : parsed
  const temporary = `${path}.${process.pid}.w3.tmp`
  writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function opencodeRuntimeEnvSnapshotPath(): string {
  return join(resolveKortixRuntimeStateDirectory(), 'opencode-runtime-env-snapshot.json')
}

/**
 * Persist the config-affecting OpenCode runtime env this daemon PROCESS has
 * applied via `/kortix/env`, so a fresh daemon process (a respawn, an agent
 * swap, a redeploy) can restore the same baseline before it evaluates the
 * next push.
 *
 * WHY THIS EXISTS: `process.env` is process-local. A name this daemon set
 * in-memory (control.ts's `applyOpencodeRuntimeEnv`) is gone the instant the
 * process exits — a fresh process inherits only what its own supervisor/OS
 * environment carries, not what a PRIOR daemon process wrote into its own
 * memory. Several of these names (`KORTIX_SECRET_CAPABILITIES` among them)
 * are delivered ONLY by a live push, never baked into the box's boot env, so
 * after ANY daemon restart the very next push of an UNCHANGED value reads as
 * "changed" — because the fresh process's baseline is `undefined`, not the
 * value the API already believes it delivered. That forced an avoidable
 * OpenCode respawn on every long-lived box within ~30 minutes of ANY release
 * that restarts the daemon (2026-09-29 incident): the release's own agent
 * swap armed the trap, and the next routine `/kortix/env` push tripped it.
 *
 * Best-effort: a failed write leaves the box exactly as it was — the next
 * push still applies correctly, just without amnesia protection this once.
 */
export function writeOpencodeRuntimeEnvSnapshot(values: Readonly<Record<string, string>>): void {
  try {
    const path = opencodeRuntimeEnvSnapshotPath()
    ensurePrivateRuntimeStateDirectory(path)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(values), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    logger.warn('[runtime-state] failed to persist opencode runtime env snapshot', err)
  }
}

/**
 * Best-effort read of the snapshot `writeOpencodeRuntimeEnvSnapshot` wrote.
 * `{}` on any failure, unparseable content, or absence — never invents a
 * value nobody actually applied.
 */
export function readOpencodeRuntimeEnvSnapshot(): Record<string, string> {
  try {
    const path = opencodeRuntimeEnvSnapshotPath()
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[name] = value
    }
    return out
  } catch {
    return {}
  }
}
