import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { mkdir, rm } from 'fs/promises'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { SecretStore } from '../services/secret-store'
import { syncSecretToAuth } from '../services/auth-sync'
import { updateBootstrapKey } from '../services/bootstrap-env'
import {
  ErrorResponse,
  UnauthorizedResponse,
  SecretsListResponse,
  SetBulkEnvBody,
  SetBulkEnvResponse,
  SetSingleEnvBody,
  SetSingleEnvResponse,
  DeleteEnvResponse,
  RotateTokenBody,
  RotateTokenResponse,
} from '../schemas/common'

const envRouter = new Hono()
const secretStore = new SecretStore()

const S6_ENV_DIR = process.env.S6_ENV_DIR || '/run/s6/container_environment'

// NOTE: Per-route auth middleware removed — global auth in index.ts now
// always enforces INTERNAL_SERVICE_KEY on all routes (auto-generated if not set).

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function writeS6Env(key: string, value: string): Promise<void> {
  if (!existsSync(S6_ENV_DIR)) {
    await mkdir(S6_ENV_DIR, { recursive: true })
  }
  await Bun.write(`${S6_ENV_DIR}/${key}`, value)
}

async function deleteS6Env(key: string): Promise<void> {
  try { await rm(`${S6_ENV_DIR}/${key}`) } catch {}
}

async function safeJsonBody(c: any): Promise<any | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function isValidEnvKey(key: string): boolean {
  return !!key && key.length <= 255 && !key.includes('/') && !key.includes('\0')
}

/**
 * Resolve a PID that is safe to pass to process.kill() from this container.
 * NSpid usually collapses to the same PID now, but reading it keeps restart
 * logic namespace-safe if the runtime layout ever changes again.
 */
function getInnerNsPid(procPid: number): number | null {
  try {
    const status = readFileSync(`/proc/${procPid}/status`, 'utf-8')
    const nspidLine = status.split('\n').find(l => l.startsWith('NSpid:'))
    if (!nspidLine) return null
    const nspids = nspidLine.split(/\s+/).slice(1).map(Number)
    const innerPid = nspids[nspids.length - 1]
    return (!isNaN(innerPid) && innerPid > 0) ? innerPid : null
  } catch {
    return null
  }
}

async function restartServices(services?: string[]): Promise<void> {
  // Kill supervised processes directly so s6 auto-restarts them with fresh env.
  //
  // The opencode CLI is a Node wrapper → native binary chain. s6-svc -r
  // only SIGTERMs the supervised PID and doesn't propagate to grandchildren.
  //
  // Read NSpid from /proc/{pid}/status before kill() so service restarts stay
  // namespace-safe even if the runtime layout changes.
  const restartAll = !services || services.length === 0
  const restartOpencode = restartAll || services?.includes('opencode')

  try {
    const killed: number[] = []

    for (const entry of readdirSync('/proc')) {
      const pid = parseInt(entry, 10)
      if (isNaN(pid) || pid <= 1) continue
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim()
        // Kill native opencode binaries (comm="opencode")
        if (restartOpencode && comm === 'opencode') {
          const innerPid = getInnerNsPid(pid)
          if (innerPid) {
            process.kill(innerPid, 9)
            killed.push(innerPid)
          }
          continue
        }
        // Kill node/bun wrappers by cmdline
        if (comm === 'node' || comm === 'MainThread' || comm === 'bun') {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
          if (restartOpencode && (cmdline.includes('/usr/bin/opencode') || cmdline.includes('/usr/local/bin/opencode') || cmdline.includes('opencode serve --port 4096'))) {
            const innerPid = getInnerNsPid(pid)
            if (innerPid) {
              process.kill(innerPid, 9)
              killed.push(innerPid)
            }
            continue
          }
        }
      } catch {}
    }

    console.log(`[ENV API] restart services: killed inner pids=${killed.join(',') || 'none'}`)
    // s6 detects longrun died → auto-restarts with fresh env via with-contenv.
  } catch (e) {
    console.error(`[ENV API] restart services: error=${e}`)
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// NOTE: Tools use getEnv() which hot-reads from the s6 env directory (tmpfs).
// Setting a key writes the s6 env file, making it instantly available to tools
// WITHOUT restarting OpenCode. Restart is ONLY used by rotate-token (which
// changes the encryption key and requires a fresh process). Normal set/delete
// operations never restart.

// GET /env — list all secrets (full values).
envRouter.get('/',
  describeRoute({
    tags: ['Secrets'],
    summary: 'List all secrets',
    description: 'Returns all stored environment variables / secrets with their full values.',
    responses: {
      200: { description: 'Secret list', content: { 'application/json': { schema: resolver(SecretsListResponse) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(UnauthorizedResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const envVars = await secretStore.getAll()
      return c.json({ secrets: envVars })
    } catch (error) {
      console.error('[ENV API] Error listing:', error)
      return c.json({ error: 'Failed to list environment variables' }, 500)
    }
  },
)

// POST /env — set multiple keys at once. { keys: { K: V, ... } }
// All vars are written to the s6 env dir and picked up live via getEnv().
// This route NEVER restarts OpenCode. The only restart path is the dedicated
// POST /env/rotate-token endpoint (explicit token rotation).
envRouter.post('/',
  describeRoute({
    tags: ['Secrets'],
    summary: 'Set multiple secrets',
    description: 'Bulk-set environment variables. All vars are written to the s6 env dir and available immediately via getEnv(). Never restarts services.',
    responses: {
      200: { description: 'Keys updated', content: { 'application/json': { schema: resolver(SetBulkEnvResponse) } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(UnauthorizedResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const body = await safeJsonBody(c)
      if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
      const keys = body?.keys
      if (!keys || typeof keys !== 'object') {
        return c.json({ error: 'Request body must contain a "keys" object' }, 400)
      }
      let updated = 0
      for (const [key, value] of Object.entries(keys as Record<string, unknown>)) {
        if (typeof value !== 'string') continue
        await secretStore.setEnv(key, value)
        await writeS6Env(key, value)
        await syncSecretToAuth(key, value)  // sync provider keys → auth.json
        updateBootstrapKey(key, value)  // persist core vars for bootstrap recovery
        updated++
      }
      return c.json({ ok: true, updated, restarted: false })
    } catch (error) {
      console.error('[ENV API] Error setting bulk:', error)
      return c.json({ error: 'Failed to set environment variables' }, 500)
    }
  },
)

// GET /env/:key — get a single key (raw value).
envRouter.get('/:key',
  describeRoute({
    tags: ['Secrets'],
    summary: 'Get a single secret',
    description: 'Returns the value of a single secret by key. Returns 200 with null value when key does not exist.',
    responses: {
      200: { description: 'Secret value (key→value object)', content: { 'application/json': { schema: resolver(z.record(z.string(), z.string().nullable())) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(UnauthorizedResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const key = c.req.param('key')
      if (!isValidEnvKey(key)) return c.json({ error: 'Invalid key' }, 400)
      const value = await secretStore.get(key)
      // Return 200 with null value when key doesn't exist — avoids 404 retry loops
      // in the frontend (e.g. ONBOARDING_COMPLETE before first onboarding).
      return c.json({ [key]: value })
    } catch (error) {
      console.error('[ENV API] Error getting key:', error)
      return c.json({ error: 'Failed to get environment variable' }, 500)
    }
  },
)

// POST /env/rotate-token — rotate KORTIX_TOKEN.
// Encryption is decoupled from KORTIX_TOKEN, so this just updates the token
// value and restarts services. No re-encryption needed.
envRouter.post('/rotate-token',
  describeRoute({
    tags: ['Secrets'],
    summary: 'Rotate KORTIX_TOKEN',
    description: 'Rotates the KORTIX_TOKEN used for sandbox↔API authentication. Encryption is decoupled — secrets are NOT re-encrypted. Always restarts services.',
    responses: {
      200: { description: 'Token rotated', content: { 'application/json': { schema: resolver(RotateTokenResponse) } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(UnauthorizedResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const body = await safeJsonBody(c)
      if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
      const newToken = body?.token
      if (!newToken || typeof newToken !== 'string') {
        return c.json({ error: 'Request body must contain a "token" string' }, 400)
      }

      // Update token — encryption is decoupled, no re-encryption needed
      const result = await secretStore.rotateToken(newToken)

      // Persist new token to s6 env dir + bootstrap so it survives service/container restarts
      await writeS6Env('KORTIX_TOKEN', newToken)
      updateBootstrapKey('KORTIX_TOKEN', newToken)

      // Restart OpenCode to pick up the new token
      await restartServices(['opencode'])

      console.log(`[ENV API] KORTIX_TOKEN rotated. ${result.rotated} secret(s) unaffected (encryption decoupled).`)
      return c.json({ ok: true, ...result })
    } catch (error) {
      console.error('[ENV API] Token rotation error:', error)
      return c.json({ error: 'Failed to rotate token' }, 500)
    }
  },
)

// POST /env/:key — set a single key. { value: "..." }
// Never restarts services — tools pick up new values via s6 env dir.
envRouter.post('/:key',
  describeRoute({
    tags: ['Secrets'],
    summary: 'Set a single secret',
    description: 'Sets a single environment variable. Does NOT restart services — tools pick up values via s6 env dir instantly.',
    responses: {
      200: { description: 'Key set', content: { 'application/json': { schema: resolver(SetSingleEnvResponse) } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(UnauthorizedResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const key = c.req.param('key')
      if (!isValidEnvKey(key)) return c.json({ error: 'Invalid key' }, 400)
      const body = await safeJsonBody(c)
      if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
      if (!body || typeof body.value !== 'string') {
        return c.json({ error: 'Request body must contain a "value" field' }, 400)
      }
      await secretStore.setEnv(key, body.value)
      await writeS6Env(key, body.value)
      await syncSecretToAuth(key, body.value)  // sync provider keys → auth.json
      updateBootstrapKey(key, body.value)  // persist core vars for bootstrap recovery
      return c.json({ ok: true, key, restarted: false })
    } catch (error) {
      console.error('[ENV API] Error setting key:', error)
      return c.json({ error: 'Failed to set environment variable' }, 500)
    }
  },
)

// PUT /env/:key — alias for POST (frontend uses PUT for set).
// Never restarts services — tools pick up new values via s6 env dir.
envRouter.put('/:key',
  describeRoute({
    tags: ['Secrets'],
    summary: 'Set a single secret (PUT)',
    description: 'Alias for POST /env/:key. Sets a single environment variable. Does NOT restart services.',
    responses: {
      200: { description: 'Key set', content: { 'application/json': { schema: resolver(SetSingleEnvResponse) } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(UnauthorizedResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const key = c.req.param('key')
      if (!isValidEnvKey(key)) return c.json({ error: 'Invalid key' }, 400)
      const body = await safeJsonBody(c)
      if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
      if (!body || typeof body.value !== 'string') {
        return c.json({ error: 'Request body must contain a "value" field' }, 400)
      }
      await secretStore.setEnv(key, body.value)
      await writeS6Env(key, body.value)
      await syncSecretToAuth(key, body.value)  // sync provider keys → auth.json
      updateBootstrapKey(key, body.value)  // persist core vars for bootstrap recovery
      return c.json({ ok: true, key, restarted: false })
    } catch (error) {
      console.error('[ENV API] Error setting key:', error)
      return c.json({ error: 'Failed to set environment variable' }, 500)
    }
  },
)

// DELETE /env/:key — remove a key. Deletes from secret store and s6 env dir.
// Does NOT restart services. The s6 env file removal means getEnv() will
// fall back to process.env (stale) but new tool invocations won't see the key.
envRouter.delete('/:key',
  describeRoute({
    tags: ['Secrets'],
    summary: 'Delete a secret',
    description: 'Removes an environment variable. Does NOT restart services.',
    responses: {
      200: { description: 'Key deleted', content: { 'application/json': { schema: resolver(DeleteEnvResponse) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(UnauthorizedResponse) } } },
      500: { description: 'Server error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const key = c.req.param('key')
      if (!isValidEnvKey(key)) return c.json({ error: 'Invalid key' }, 400)
      await secretStore.deleteEnv(key)
      await deleteS6Env(key)
      await syncSecretToAuth(key, '')  // clear provider key from auth.json
      return c.json({ ok: true, key })
    } catch (error) {
      console.error('[ENV API] Error deleting key:', error)
      return c.json({ error: 'Failed to delete environment variable' }, 500)
    }
  },
)

export default envRouter

// z import needed for inline resolver usage
import { z } from 'zod'
