import { describe, expect, test } from 'bun:test'
import { decryptEnrollment, encryptEnrollment } from './device-auth'

describe('compute-node device authorization encryption', () => {
  test('round-trips the enrollment token with the device secret hash', () => {
    const encrypted = encryptEnrollment('kortix_enroll_secret', 'device-secret-hash')
    expect(decryptEnrollment(encrypted, 'device-secret-hash')).toBe('kortix_enroll_secret')
    expect(JSON.stringify(encrypted)).not.toContain('kortix_enroll_secret')
  })

  test('rejects another device secret hash', () => {
    const encrypted = encryptEnrollment('kortix_enroll_secret', 'device-secret-hash')
    expect(() => decryptEnrollment(encrypted, 'another-device-secret-hash')).toThrow()
  })

  test('rejects modified ciphertext', () => {
    const encrypted = encryptEnrollment('kortix_enroll_secret', 'device-secret-hash')
    encrypted.ciphertext = `${encrypted.ciphertext.slice(0, -2)}AA`
    expect(() => decryptEnrollment(encrypted, 'device-secret-hash')).toThrow()
  })
})
