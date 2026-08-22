import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface EncryptedEnrollment { iv: string; ciphertext: string; tag: string }

function key(secretHash: string): Buffer { return createHash('sha256').update(`kortix-node-device-auth:${secretHash}`).digest() }

export function encryptEnrollment(token: string, secretHash: string): EncryptedEnrollment {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secretHash), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

export function decryptEnrollment(value: EncryptedEnrollment, secretHash: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key(secretHash), Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}
