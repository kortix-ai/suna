import { readFile, writeFile, mkdir, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

interface SecretsData {
  secrets: Record<string, string>
  /** Schema version. v1 = KORTIX_TOKEN-derived key, v2 = dedicated encryption key. */
  version: number
}

/**
 * Persistent encrypted secret store.
 *
 * Encryption is decoupled from KORTIX_TOKEN. A dedicated random encryption key
 * is generated on first use and stored at `.encryption-key` alongside the
 * secrets file. This means:
 *
 *   - Changing KORTIX_TOKEN (API restart, rotation, pool claim) does NOT
 *     destroy secrets. The encryption key is independent.
 *   - The encryption key survives container restarts as long as /workspace
 *     is persisted (which it is — it's the workspace volume).
 *   - Migration from v1 (KORTIX_TOKEN-derived) happens automatically on
 *     first startup with the new code.
 *
 * Safety guarantees:
 *   - Secrets that fail to decrypt are NEVER deleted. They're skipped with
 *     a warning. The user must explicitly delete them.
 *   - A backup is created before any migration or bulk re-encryption.
 *   - All read→modify→write operations are serialized via an async mutex.
 */
export class SecretStore {
  private secretsPath: string
  private saltPath: string
  private encryptionKeyPath: string
  private encryptionKey: Buffer | null = null
  private salt: Buffer | null = null
  private initialized = false
  /** Async mutex — serializes all read->modify->write operations to prevent data loss */
  private lock: Promise<void> = Promise.resolve()

  constructor() {
    const persistentRoot = process.env.KORTIX_PERSISTENT_ROOT || '/persistent'
    this.secretsPath = process.env.SECRET_FILE_PATH || `${persistentRoot}/secrets/.secrets.json`
    this.saltPath = process.env.SALT_FILE_PATH || `${persistentRoot}/secrets/.salt`
    // Dedicated encryption key — lives alongside secrets, independent of KORTIX_TOKEN
    const dir = dirname(this.secretsPath)
    this.encryptionKeyPath = process.env.ENCRYPTION_KEY_PATH || join(dir, '.encryption-key')
  }

  /** Queue an async operation behind the mutex. Guarantees serial execution. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    const prev = this.lock
    this.lock = next
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private async ensureDirectories() {
    const dir = dirname(this.secretsPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    }
  }

  // ─── Initialization & Migration ─────────────────────────────────────────

  /**
   * Ensure the encryption key is ready. Runs v1→v2 migration if needed.
   * Called once at the start of every public method (under the lock).
   * After this returns, `this.encryptionKey` is set and the secrets file
   * (if any) is encrypted with the v2 key.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.ensureDirectories()

    // 1. If encryption key file exists, load it — we're already v2
    if (existsSync(this.encryptionKeyPath)) {
      const hex = (await readFile(this.encryptionKeyPath, 'utf8')).trim()
      this.encryptionKey = Buffer.from(hex, 'hex')
      this.initialized = true
      return
    }

    // 2. No encryption key file. Check if we have v1 secrets to migrate.
    if (existsSync(this.secretsPath)) {
      const data = await this.loadSecretsRaw()
      const secretKeys = Object.keys(data.secrets)
      if (secretKeys.length > 0 && data.version !== 2) {
        await this.migrateFromV1(data)
        this.initialized = true
        return
      }
    }

    // 3. No secrets or empty file — generate fresh encryption key
    this.encryptionKey = randomBytes(32)
    await writeFile(this.encryptionKeyPath, this.encryptionKey.toString('hex'), { mode: 0o600 })
    console.log('[SecretStore] Generated new encryption key (first run)')
    this.initialized = true
  }

  // ─── Encryption Key Management ──────────────────────────────────────────

  /**
   * Get the AES key for encryption/decryption.
   * Uses the dedicated encryption key + salt via scrypt for key derivation.
   * Must only be called AFTER ensureInitialized().
   */
  private async getKey(): Promise<Buffer> {
    const salt = await this.getSalt()
    return scryptSync(this.encryptionKey!, salt, 32)
  }

  /**
   * Derive a key using the LEGACY method (KORTIX_TOKEN + salt).
   * Only used during v1 → v2 migration.
   */
  private getLegacyKey(salt: Buffer): Buffer {
    return scryptSync(process.env.KORTIX_TOKEN || 'default-key', salt, 32)
  }

  private async getSalt(): Promise<Buffer> {
    if (this.salt) return this.salt
    await this.ensureDirectories()
    if (existsSync(this.saltPath)) {
      this.salt = await readFile(this.saltPath)
    } else {
      this.salt = randomBytes(32)
      await writeFile(this.saltPath, this.salt, { mode: 0o600 })
    }
    return this.salt
  }

  // ─── Encryption / Decryption ────────────────────────────────────────────

  private async encrypt(text: string): Promise<string> {
    const key = await this.getKey()
    return this.encryptWithKey(text, key)
  }

  private async decrypt(encryptedData: string): Promise<string> {
    const key = await this.getKey()
    return this.decryptWithKey(encryptedData, key)
  }

  private decryptWithKey(encryptedData: string, key: Buffer): string {
    const [ivHex, authTagHex, encrypted] = encryptedData.split(':')
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  private encryptWithKey(text: string, key: Buffer): string {
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag()
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
  }

  // ─── Migration from v1 (KORTIX_TOKEN-derived encryption) ───────────────

  /**
   * Migrate secrets from v1 (encrypted with KORTIX_TOKEN-derived key) to v2
   * (encrypted with a dedicated random key).
   *
   * Creates a backup before migration. On failure, leaves secrets untouched.
   */
  private async migrateFromV1(data: SecretsData): Promise<void> {
    const secretKeys = Object.keys(data.secrets)
    console.log(`[SecretStore] Migrating ${secretKeys.length} secret(s) from v1 (KORTIX_TOKEN-derived) to v2 (dedicated key)...`)

    try {
      // Create backup BEFORE touching anything
      await this.createBackup('pre-v2-migration')

      // Try to decrypt with the legacy key (KORTIX_TOKEN + salt)
      const salt = await this.getSalt()
      const legacyKey = this.getLegacyKey(salt)
      const decrypted: Record<string, string> = {}
      const failed: string[] = []

      for (const key of secretKeys) {
        try {
          decrypted[key] = this.decryptWithKey(data.secrets[key], legacyKey)
        } catch {
          failed.push(key)
        }
      }

      // Generate the new dedicated encryption key
      this.encryptionKey = randomBytes(32)
      await writeFile(this.encryptionKeyPath, this.encryptionKey.toString('hex'), { mode: 0o600 })

      if (Object.keys(decrypted).length === 0) {
        console.warn('[SecretStore] Migration: could not decrypt any secrets with current KORTIX_TOKEN. Secrets preserved as-is on disk.')
        return
      }

      if (failed.length > 0) {
        console.warn(`[SecretStore] Migration: ${failed.length} secret(s) could not be decrypted (will be preserved as-is): ${failed.join(', ')}`)
      }

      // Re-encrypt decrypted secrets with the new key
      const newKey = await this.getKey()
      const newSecrets: Record<string, string> = {}

      // Preserve failed entries as-is (they're still encrypted, just not with a key we know)
      for (const key of failed) {
        newSecrets[key] = data.secrets[key]
      }

      // Re-encrypt the ones we could decrypt
      for (const [key, value] of Object.entries(decrypted)) {
        newSecrets[key] = this.encryptWithKey(value, newKey)
      }

      const newData: SecretsData = { secrets: newSecrets, version: 2 }
      await this.saveSecrets(newData)

      console.log(`[SecretStore] Migration complete: ${Object.keys(decrypted).length} migrated, ${failed.length} preserved as-is`)
    } catch (err) {
      console.error('[SecretStore] Migration failed (secrets preserved):', err)
      // Generate key anyway so new secrets work
      if (!this.encryptionKey) {
        this.encryptionKey = randomBytes(32)
        await writeFile(this.encryptionKeyPath, this.encryptionKey.toString('hex'), { mode: 0o600 })
      }
    }
  }

  // ─── Backup ─────────────────────────────────────────────────────────────

  /**
   * Create a timestamped backup of the secrets file.
   * Backups are stored alongside the secrets file.
   */
  private async createBackup(label: string): Promise<string | null> {
    if (!existsSync(this.secretsPath)) return null
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.secretsPath}.backup-${label}-${ts}`
    await copyFile(this.secretsPath, backupPath)
    console.log(`[SecretStore] Backup created: ${backupPath}`)
    return backupPath
  }

  // ─── File I/O ───────────────────────────────────────────────────────────

  /** Load secrets file without triggering initialization. Used by migration. */
  private async loadSecretsRaw(): Promise<SecretsData> {
    await this.ensureDirectories()
    if (!existsSync(this.secretsPath)) {
      return { secrets: {}, version: 2 }
    }
    const data = await readFile(this.secretsPath, 'utf8')
    const parsed = JSON.parse(data) as SecretsData
    if (!parsed.version) parsed.version = 1
    return parsed
  }

  /** Load secrets (ensures initialized first). */
  private async loadSecrets(): Promise<SecretsData> {
    await this.ensureInitialized()
    return this.loadSecretsRaw()
  }

  private async saveSecrets(data: SecretsData): Promise<void> {
    await this.ensureDirectories()
    await writeFile(this.secretsPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.withLock(async () => {
      const data = await this.loadSecrets()
      const encrypted = data.secrets[key]
      if (!encrypted) return null
      try {
        return await this.decrypt(encrypted)
      } catch {
        // Cannot decrypt — but DO NOT delete. Just return null and warn.
        console.warn(`[SecretStore] Cannot decrypt key "${key}" (wrong encryption key). Secret preserved on disk.`)
        return null
      }
    })
  }

  async set(key: string, value: string): Promise<void> {
    return this.withLock(async () => {
      const data = await this.loadSecrets()
      data.secrets[key] = await this.encrypt(value)
      data.version = 2
      await this.saveSecrets(data)
    })
  }

  async delete(key: string): Promise<void> {
    return this.withLock(async () => {
      const data = await this.loadSecrets()
      delete data.secrets[key]
      await this.saveSecrets(data)
    })
  }

  async listKeys(): Promise<string[]> {
    return this.withLock(async () => {
      const data = await this.loadSecrets()
      return Object.keys(data.secrets)
    })
  }

  /**
   * Load all secrets into process.env.
   *
   * Secrets that fail to decrypt are SKIPPED (not deleted).
   * They remain on disk for recovery once the correct key is available.
   */
  async loadIntoProcessEnv(): Promise<void> {
    return this.withLock(async () => {
      const data = await this.loadSecrets()
      const keys = Object.keys(data.secrets)
      let loaded = 0
      let skipped = 0
      for (const key of keys) {
        try {
          const value = await this.decrypt(data.secrets[key])
          process.env[key] = value
          loaded++
        } catch {
          skipped++
        }
      }
      if (skipped > 0) {
        console.warn(`[SecretStore] Skipped ${skipped} undecryptable secret(s) (preserved on disk for recovery)`)
      }
      if (loaded > 0) {
        console.log(`[SecretStore] Loaded ${loaded} env var(s)`)
      }
    })
  }

  /**
   * Get all secrets decrypted.
   *
   * Secrets that fail to decrypt are SKIPPED (not deleted).
   * Only returns secrets that can be successfully decrypted.
   */
  async getAll(): Promise<Record<string, string>> {
    return this.withLock(async () => {
      const data = await this.loadSecrets()
      const result: Record<string, string> = {}
      let skipped = 0
      for (const key of Object.keys(data.secrets)) {
        try {
          result[key] = await this.decrypt(data.secrets[key])
        } catch {
          skipped++
        }
      }
      if (skipped > 0) {
        console.warn(`[SecretStore] getAll: skipped ${skipped} undecryptable secret(s) (preserved on disk)`)
      }
      return result
    })
  }

  async setEnv(key: string, value: string): Promise<void> {
    await this.set(key, value)
    process.env[key] = value
  }

  async deleteEnv(key: string): Promise<void> {
    await this.delete(key)
    delete process.env[key]
  }

  /**
   * Rotate KORTIX_TOKEN.
   *
   * Since encryption is now decoupled from KORTIX_TOKEN, this method just
   * updates the token in process.env. No re-encryption needed.
   *
   * For backward compatibility, this is still called by the rotate-token
   * endpoint. The endpoint handles the process.env update, s6 write,
   * bootstrap persistence, and service restart.
   */
  async rotateToken(newToken: string): Promise<{ rotated: number }> {
    return this.withLock(async () => {
      // Count existing secrets for the response
      const data = await this.loadSecrets()
      const count = Object.keys(data.secrets).length

      // Update the token in process.env — encryption key is unaffected
      process.env.KORTIX_TOKEN = newToken

      console.log(`[SecretStore] KORTIX_TOKEN rotated. ${count} secret(s) unaffected (encryption is decoupled).`)
      return { rotated: count }
    })
  }

  /**
   * Rotate the encryption key itself.
   * Decrypts all secrets with the current key, generates a new key,
   * and re-encrypts everything. Creates a backup first.
   */
  async rotateEncryptionKey(): Promise<{ rotated: number; failed: number }> {
    return this.withLock(async () => {
      const data = await this.loadSecrets()
      const secretKeys = Object.keys(data.secrets)
      if (secretKeys.length === 0) return { rotated: 0, failed: 0 }

      // Backup before rotation
      await this.createBackup('pre-key-rotation')

      // Decrypt everything with current key
      const decrypted: Record<string, string> = {}
      const failed: string[] = []
      for (const key of secretKeys) {
        try {
          decrypted[key] = await this.decrypt(data.secrets[key])
        } catch {
          failed.push(key)
        }
      }

      // Generate new encryption key (also resets salt)
      this.encryptionKey = randomBytes(32)
      this.salt = null // force fresh salt
      if (existsSync(this.saltPath)) {
        // Back up old salt
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        await copyFile(this.saltPath, `${this.saltPath}.backup-${ts}`)
      }
      const newSalt = randomBytes(32)
      this.salt = newSalt
      await writeFile(this.saltPath, newSalt, { mode: 0o600 })
      await writeFile(this.encryptionKeyPath, this.encryptionKey.toString('hex'), { mode: 0o600 })

      // Re-encrypt with new key
      const newKey = await this.getKey()
      const newSecrets: Record<string, string> = {}

      // Preserve failed entries as-is
      for (const key of failed) {
        newSecrets[key] = data.secrets[key]
      }

      for (const [key, value] of Object.entries(decrypted)) {
        newSecrets[key] = this.encryptWithKey(value, newKey)
      }

      const newData: SecretsData = { secrets: newSecrets, version: 2 }
      await this.saveSecrets(newData)

      console.log(`[SecretStore] Encryption key rotated: ${Object.keys(decrypted).length} re-encrypted, ${failed.length} preserved as-is`)
      return { rotated: Object.keys(decrypted).length, failed: failed.length }
    })
  }
}
