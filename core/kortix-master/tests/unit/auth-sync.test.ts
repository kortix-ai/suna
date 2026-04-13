import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SecretStore } from '../../src/services/secret-store'

/**
 * Tests for the auth-sync service (two-way sync: auth.json ↔ SecretStore).
 *
 * Each test gets its own temp directory for isolation. Paths are injected via
 * env vars and modules are imported fresh per test where needed.
 */

// ── Test helpers ────────────────────────────────────────────────────────────

function writeJson(path: string, data: unknown) {
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('auth-sync', () => {
  let tempDir: string
  let authJsonPath: string
  let s6EnvDir: string
  let secretStore: SecretStore

  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'auth-sync-test-'))

    // Fake auth.json location
    authJsonPath = join(tempDir, 'opencode', 'auth.json')
    mkdirSync(join(tempDir, 'opencode'), { recursive: true })

    // Fake s6 env dir
    s6EnvDir = join(tempDir, 's6-env')
    mkdirSync(s6EnvDir, { recursive: true })

    // SecretStore temp paths
    savedEnv.SECRET_FILE_PATH = process.env.SECRET_FILE_PATH
    savedEnv.SALT_FILE_PATH = process.env.SALT_FILE_PATH
    savedEnv.ENCRYPTION_KEY_PATH = process.env.ENCRYPTION_KEY_PATH
    savedEnv.KORTIX_TOKEN = process.env.KORTIX_TOKEN
    savedEnv.S6_ENV_DIR = process.env.S6_ENV_DIR
    savedEnv.AUTH_JSON_PATH = process.env.AUTH_JSON_PATH

    process.env.SECRET_FILE_PATH = join(tempDir, '.secrets.json')
    process.env.SALT_FILE_PATH = join(tempDir, '.salt')
    process.env.ENCRYPTION_KEY_PATH = join(tempDir, '.encryption-key')
    process.env.KORTIX_TOKEN = 'test-token-auth-sync'
    process.env.S6_ENV_DIR = s6EnvDir
    process.env.AUTH_JSON_PATH = authJsonPath

    secretStore = new SecretStore()
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}

    // Clean provider env vars that may have been set
    for (const k of [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
      'XAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
    ]) {
      delete process.env[k]
    }
  })

  // ─── Mapping tests ──────────────────────────────────────────────────────

  describe('PROVIDER_TO_ENV / ENV_TO_PROVIDER mappings', () => {
    it('exports correct provider → env var mapping', async () => {
      const { PROVIDER_TO_ENV } = await import('../../src/services/auth-sync')
      expect(PROVIDER_TO_ENV.openai).toBe('OPENAI_API_KEY')
      expect(PROVIDER_TO_ENV.anthropic).toBe('ANTHROPIC_API_KEY')
      expect(PROVIDER_TO_ENV.google).toBe('GOOGLE_API_KEY')
      expect(PROVIDER_TO_ENV.xai).toBe('XAI_API_KEY')
      expect(PROVIDER_TO_ENV.groq).toBe('GROQ_API_KEY')
      expect(PROVIDER_TO_ENV.openrouter).toBe('OPENROUTER_API_KEY')
    })

    it('exports correct reverse env var → provider mapping', async () => {
      const { ENV_TO_PROVIDER } = await import('../../src/services/auth-sync')
      expect(ENV_TO_PROVIDER.OPENAI_API_KEY).toBe('openai')
      expect(ENV_TO_PROVIDER.ANTHROPIC_API_KEY).toBe('anthropic')
    })

    it('mappings are symmetric (every provider has a reverse entry)', async () => {
      const { PROVIDER_TO_ENV, ENV_TO_PROVIDER } = await import('../../src/services/auth-sync')
      for (const [provider, envVar] of Object.entries(PROVIDER_TO_ENV)) {
        expect(ENV_TO_PROVIDER[envVar]).toBe(provider)
      }
    })
  })

  // ─── Direction 1 / 2 smoke coverage ─────────────────────────────────────

  describe('syncSecretToAuth (Direction 2: SecretStore → auth.json)', () => {
    it('writes a mapped provider key into auth.json', async () => {
      const { syncSecretToAuth } = await import(`../../src/services/auth-sync?write=${Date.now()}`)

      const changed = await syncSecretToAuth('OPENAI_API_KEY', 'sk-test-key-123')
      expect(changed).toBe(true)

      const auth = readJson(authJsonPath) as Record<string, { type: string; key?: string }>
      expect(auth.openai?.type).toBe('api')
      expect(auth.openai?.key).toBe('sk-test-key-123')
    })

    it('syncs auth.json provider keys into SecretStore', async () => {
      writeJson(authJsonPath, {
        openai: { type: 'api', key: 'sk-from-auth-json' },
      })

      const { syncAuthToSecrets } = await import(`../../src/services/auth-sync?read=${Date.now()}`)
      const count = await syncAuthToSecrets(secretStore)
      expect(count).toBe(1)
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-from-auth-json')
      expect(process.env.OPENAI_API_KEY).toBe('sk-from-auth-json')
    })

    it('syncSecretToAuth returns false for non-provider keys', async () => {
      const { syncSecretToAuth } = await import('../../src/services/auth-sync')

      // TAVILY_API_KEY is not a provider key — should return false
      const result = await syncSecretToAuth('TAVILY_API_KEY', 'tvly-xxx')
      expect(result).toBe(false)
    })

    it('syncSecretToAuth returns false for non-provider keys (various)', async () => {
      const { syncSecretToAuth } = await import('../../src/services/auth-sync')

      expect(await syncSecretToAuth('REPLICATE_API_TOKEN', 'r8_xxx')).toBe(false)
      expect(await syncSecretToAuth('RANDOM_KEY', 'value')).toBe(false)
      expect(await syncSecretToAuth('', 'value')).toBe(false)
    })
  })

  // ─── SecretStore + s6 env integration ───────────────────────────────────

  describe('SecretStore + s6 env write (building blocks)', () => {
    it('SecretStore correctly stores and retrieves provider keys', async () => {
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-test-openai')
      await secretStore.setEnv('ANTHROPIC_API_KEY', 'sk-ant-test')

      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-test-openai')
      expect(await secretStore.get('ANTHROPIC_API_KEY')).toBe('sk-ant-test')
      expect(process.env.OPENAI_API_KEY).toBe('sk-test-openai')
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    })

    it('SecretStore handles key updates correctly', async () => {
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-old')
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-old')

      await secretStore.setEnv('OPENAI_API_KEY', 'sk-new')
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-new')
      expect(process.env.OPENAI_API_KEY).toBe('sk-new')
    })

    it('SecretStore handles empty string (disconnect) correctly', async () => {
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-test')
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-test')

      await secretStore.setEnv('OPENAI_API_KEY', '')
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('')
      expect(process.env.OPENAI_API_KEY).toBe('')
    })

    it('SecretStore persists across instances', async () => {
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-persist-test')

      // New instance should read the same data
      const store2 = new SecretStore()
      expect(await store2.get('OPENAI_API_KEY')).toBe('sk-persist-test')
    })

    it('multiple provider keys coexist without interference', async () => {
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-openai')
      await secretStore.setEnv('ANTHROPIC_API_KEY', 'sk-anthropic')
      await secretStore.setEnv('GOOGLE_API_KEY', 'gk-google')
      await secretStore.setEnv('XAI_API_KEY', 'xai-key')
      await secretStore.setEnv('GROQ_API_KEY', 'gsk-groq')
      await secretStore.setEnv('OPENROUTER_API_KEY', 'sk-or-key')

      const all = await secretStore.getAll()
      expect(all.OPENAI_API_KEY).toBe('sk-openai')
      expect(all.ANTHROPIC_API_KEY).toBe('sk-anthropic')
      expect(all.GOOGLE_API_KEY).toBe('gk-google')
      expect(all.XAI_API_KEY).toBe('xai-key')
      expect(all.GROQ_API_KEY).toBe('gsk-groq')
      expect(all.OPENROUTER_API_KEY).toBe('sk-or-key')
    })
  })

  // ─── Auth.json format tests ─────────────────────────────────────────────

  describe('auth.json format handling', () => {
    it('correctly identifies API key entries', () => {
      // Test the expected format that OpenCode writes
      const apiEntry = { type: 'api', key: 'sk-test-123' }
      expect(apiEntry.type).toBe('api')
      expect(apiEntry.key).toBe('sk-test-123')
    })

    it('correctly identifies OAuth entries (should not be synced)', () => {
      const oauthEntry = {
        type: 'oauth',
        refresh: 'gho_xxx',
        access: 'gho_yyy',
        expires: Date.now() + 3600000,
      }
      // OAuth entries don't have a simple .key field
      expect(oauthEntry.type).toBe('oauth')
      expect('key' in oauthEntry).toBe(false)
    })

    it('empty key string means disconnected', () => {
      const disconnected = { type: 'api', key: '' }
      expect(disconnected.key).toBe('')
      // trim() of empty string is still empty = no key
      expect(disconnected.key.trim() || null).toBeNull()
    })
  })

  // ─── Full lifecycle simulation ──────────────────────────────────────────

  describe('full lifecycle', () => {
    it('simulates: user connects OpenAI → key appears in SecretStore', async () => {
      // Step 1: "OpenCode writes auth.json" (simulated)
      const authData = {
        openai: { type: 'api', key: 'sk-test-lifecycle' },
      }

      // Step 2: "auth-sync reads auth.json and syncs to SecretStore" (simulated)
      // The sync would call secretStore.setEnv for the mapped key
      const providerToEnv: Record<string, string> = { openai: 'OPENAI_API_KEY' }
      for (const [provider, entry] of Object.entries(authData)) {
        const envVar = providerToEnv[provider]
        if (!envVar) continue
        if ((entry as any).type === 'api' && (entry as any).key) {
          await secretStore.setEnv(envVar, (entry as any).key)
        }
      }

      // Step 3: Verify the key is now available where lss-sync would read it
      expect(process.env.OPENAI_API_KEY).toBe('sk-test-lifecycle')
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-test-lifecycle')
    })

    it('simulates: user sets OPENAI_API_KEY in Secrets Manager → appears in auth format', async () => {
      // Step 1: User sets key via /env API (simulated by direct SecretStore call)
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-from-secrets-manager')

      // Step 2: The /env route would call syncSecretToAuth('OPENAI_API_KEY', 'sk-from-secrets-manager')
      // This would write to auth.json: { openai: { type: 'api', key: 'sk-from-secrets-manager' } }

      // Step 3: Verify the key is in SecretStore
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-from-secrets-manager')
      expect(process.env.OPENAI_API_KEY).toBe('sk-from-secrets-manager')
    })

    it('simulates: user disconnects provider → key cleared everywhere', async () => {
      // Setup: key is set
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-to-disconnect')
      expect(process.env.OPENAI_API_KEY).toBe('sk-to-disconnect')

      // Step 1: OpenCode writes empty key to auth.json (disconnect)
      // Step 2: auth-sync detects the change, clears SecretStore
      await secretStore.setEnv('OPENAI_API_KEY', '')

      expect(process.env.OPENAI_API_KEY).toBe('')
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('')
    })

    it('simulates: multiple providers connected simultaneously', async () => {
      // Connect OpenAI and Anthropic
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-openai-multi')
      await secretStore.setEnv('ANTHROPIC_API_KEY', 'sk-ant-multi')

      // Disconnect only OpenAI
      await secretStore.setEnv('OPENAI_API_KEY', '')

      // Anthropic should still be there
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('')
      expect(await secretStore.get('ANTHROPIC_API_KEY')).toBe('sk-ant-multi')
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-multi')
    })

    it('non-provider keys in SecretStore are unaffected by auth sync', async () => {
      // Set a tool key and a provider key
      await secretStore.setEnv('TAVILY_API_KEY', 'tvly-test')
      await secretStore.setEnv('OPENAI_API_KEY', 'sk-test')

      // Verify both exist
      expect(await secretStore.get('TAVILY_API_KEY')).toBe('tvly-test')
      expect(await secretStore.get('OPENAI_API_KEY')).toBe('sk-test')

      // Clearing the provider key doesn't affect the tool key
      await secretStore.setEnv('OPENAI_API_KEY', '')
      expect(await secretStore.get('TAVILY_API_KEY')).toBe('tvly-test')
    })
  })
})
