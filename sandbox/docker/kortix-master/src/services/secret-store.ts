import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { config } from '../config'

interface SecretsData {
  secrets: Record<string, string>
  version: number
}

export class SecretStore {
  private secretsPath: string
  private saltPath: string
  private salt: Buffer | null = null

  constructor() {
    this.secretsPath = config.SECRET_FILE_PATH
    this.saltPath = config.SALT_FILE_PATH
  }

  private async ensureDirectories() {
    const dir = dirname(this.secretsPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    }
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

  private async getKey(): Promise<Buffer> {
    const salt = await this.getSalt()
    // Derive key from KORTIX_TOKEN and salt
    return scryptSync(config.KORTIX_TOKEN || 'default-key', salt, 32)
  }

  private async encrypt(text: string): Promise<string> {
    const key = await this.getKey()
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-gcm', key, iv)

    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag()

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
  }

  private async decrypt(encryptedData: string): Promise<string> {
    const key = await this.getKey()
    const [ivHex, authTagHex, encrypted] = encryptedData.split(':')

    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)

    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  }

  private async loadSecrets(): Promise<SecretsData> {
    await this.ensureDirectories()

    if (!existsSync(this.secretsPath)) {
      return { secrets: {}, version: 1 }
    }

    const data = await readFile(this.secretsPath, 'utf8')
    return JSON.parse(data) as SecretsData
  }

  private async saveSecrets(data: SecretsData): Promise<void> {
    await this.ensureDirectories()
    await writeFile(this.secretsPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  async get(key: string): Promise<string | null> {
    const data = await this.loadSecrets()
    const encrypted = data.secrets[key]

    if (!encrypted) return null

    return this.decrypt(encrypted)
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.loadSecrets()
    data.secrets[key] = await this.encrypt(value)
    await this.saveSecrets(data)
  }

  async delete(key: string): Promise<void> {
    const data = await this.loadSecrets()
    delete data.secrets[key]
    await this.saveSecrets(data)
  }

  async listKeys(): Promise<string[]> {
    const data = await this.loadSecrets()
    return Object.keys(data.secrets)
  }
}
