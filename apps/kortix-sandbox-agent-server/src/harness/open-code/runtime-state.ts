import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../../logger'
import { resolveKortixRuntimeStateDirectory } from '../../runtime-state-dir'

// The state directory is a host concern (every harness pins under it); the
// OpenCode pin paths below are native. Re-exported for the existing importers.
export { DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY, resolveKortixRuntimeStateDirectory } from '../../runtime-state-dir'

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
