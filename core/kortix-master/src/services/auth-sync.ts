/**
 * auth-sync — Two-way sync between OpenCode auth.json and Kortix SecretStore.
 *
 * Problem: OpenCode stores LLM keys in auth.json. Other services (lss-sync,
 * tools) read keys from s6 env (populated by SecretStore). Without sync,
 * an OPENAI_API_KEY set via the provider UI never reaches lss-sync.
 *
 * Solution: Keep both stores in sync automatically.
 *
 *   auth.json  ←→  SecretStore + s6 env
 *
 *   Direction 1 (auth.json → secrets): file watcher + boot sync
 *   Direction 2 (secrets → auth.json): hook in /env API routes
 */

import { watch, existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { SecretStore } from './secret-store'

// ─── Provider ↔ Env Var Mapping ─────────────────────────────────────────────

const PROVIDER_TO_ENV: Record<string, string> = {
  openai:     'OPENAI_API_KEY',
  anthropic:  'ANTHROPIC_API_KEY',
  google:     'GOOGLE_API_KEY',
  xai:        'XAI_API_KEY',
  groq:       'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

const ENV_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_TO_ENV).map(([p, e]) => [e, p])
)

export { PROVIDER_TO_ENV, ENV_TO_PROVIDER }

// ─── Auth.json Format ───────────────────────────────────────────────────────

// { "openai": { "type": "api", "key": "sk-..." }, "github-copilot": { "type": "oauth", ... } }
type AuthData = Record<string, { type: string; key?: string; [k: string]: unknown }>

const AUTH_JSON = process.env.AUTH_JSON_PATH
  || `${process.env.OPENCODE_STORAGE_BASE || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/opencode`}/auth.json`
const S6_ENV    = process.env.S6_ENV_DIR || '/run/s6/container_environment'

// ─── Lock ───────────────────────────────────────────────────────────────────
// Prevents feedback loops: writing auth.json triggers the watcher, which would
// try to sync back into SecretStore. The lock blocks re-entry for 500ms.

let locked = false
const lock = () => { locked = true; setTimeout(() => { locked = false }, 500) }

// ─── File I/O ───────────────────────────────────────────────────────────────

async function readAuth(): Promise<AuthData> {
  try {
    if (!existsSync(AUTH_JSON)) return {}
    return JSON.parse(await readFile(AUTH_JSON, 'utf-8'))
  } catch { return {} }
}

async function writeAuth(data: AuthData): Promise<void> {
  const dir = dirname(AUTH_JSON)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(AUTH_JSON, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

async function writeS6(key: string, value: string): Promise<void> {
  if (!existsSync(S6_ENV)) await mkdir(S6_ENV, { recursive: true })
  await Bun.write(`${S6_ENV}/${key}`, value)
}

/** Returns the API key string if this is a { type: "api", key: "..." } entry, else null. */
function apiKey(entry: AuthData[string] | undefined): string | null {
  if (!entry || entry.type !== 'api' || typeof entry.key !== 'string') return null
  return entry.key.trim() || null  // treat empty string as "no key"
}

// ─── Direction 1: auth.json → SecretStore ───────────────────────────────────

/**
 * Reads auth.json and pushes any changed provider API keys into SecretStore
 * and s6 env. Called at boot and by the file watcher.
 */
export async function syncAuthToSecrets(store: SecretStore): Promise<number> {
  if (locked) return 0
  lock()

  const auth = await readAuth()
  let count = 0

  for (const [providerID, envVar] of Object.entries(PROVIDER_TO_ENV)) {
    const key = apiKey(auth[providerID])
    const current = await store.get(envVar)

    // Key present in auth.json but missing/different in SecretStore → push it
    if (key && key !== current) {
      await store.setEnv(envVar, key)
      await writeS6(envVar, key)
      count++
      console.log(`[auth-sync] ${providerID} → ${envVar} (auth.json → secrets)`)
    }

    // Key was removed in auth.json (empty or missing) but SecretStore has it → clear it
    if (!key && current) {
      // Only clear if auth.json explicitly has this provider with empty key
      // (don't clear if the provider simply isn't in auth.json — it might not have been set yet)
      if (auth[providerID] && !apiKey(auth[providerID])) {
        await store.setEnv(envVar, '')
        await writeS6(envVar, '')
        count++
        console.log(`[auth-sync] ${providerID} disconnected → cleared ${envVar}`)
      }
    }
  }

  return count
}

// ─── Direction 2: SecretStore → auth.json ───────────────────────────────────

/**
 * Called from /env routes when a provider-related key is set or deleted.
 * Pushes the change into auth.json so OpenCode sees it too.
 */
export async function syncSecretToAuth(envVar: string, value: string): Promise<boolean> {
  const providerID = ENV_TO_PROVIDER[envVar]
  if (!providerID) return false  // not a provider key, nothing to sync
  if (locked) return false

  lock()

  const auth = await readAuth()
  const current = apiKey(auth[providerID])

  // Already in sync
  if (value && current === value) return false
  if (!value && !current) return false

  auth[providerID] = { type: 'api', key: value }
  await writeAuth(auth)
  console.log(`[auth-sync] ${envVar} → ${providerID} (secrets → auth.json)`)
  return true
}

// ─── File Watcher ───────────────────────────────────────────────────────────

let watcher: ReturnType<typeof watch> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

/**
 * Watch auth.json for changes and auto-sync to SecretStore.
 * Watches the directory (not the file) because atomic writes replace the file.
 */
export function startWatcher(store: SecretStore): void {
  if (watcher) return

  const dir = dirname(AUTH_JSON)
  if (!existsSync(dir)) {
    console.log('[auth-sync] Waiting for auth.json directory...')
    setTimeout(() => startWatcher(store), 10_000)
    return
  }

  watcher = watch(dir, (_event, file) => {
    if (file !== 'auth.json') return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(async () => {
      try {
        const n = await syncAuthToSecrets(store)
        if (n > 0) console.log(`[auth-sync] Watcher: synced ${n} key(s)`)
      } catch (err) {
        console.error('[auth-sync] Watcher error:', err)
      }
    }, 500)
  })

  console.log('[auth-sync] Watching auth.json')
}

export function stopWatcher(): void {
  if (watcher) { watcher.close(); watcher = null }
  if (debounce) { clearTimeout(debounce); debounce = null }
}
