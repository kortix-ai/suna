import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadNodeLocalPolicy } from './policy-store'

describe('kortixd local capability policy', () => {
  test('loads an owner-private policy and preserves every local ceiling', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-policy-'))
    try {
      writeFileSync(join(directory, 'policy.json'), JSON.stringify({ enabledCapabilities: ['filesystem'], allowedPaths: [directory], blockedPaths: [join(directory, 'private')], allowedCommands: ['git'], blockedCommands: ['ssh'], maxFileSize: 12, shellTimeout: 13, shellMaxTimeout: 14, shellMaxOutputSize: 15, shellEnvPassthrough: ['PATH'] }), { mode: 0o600 })
      const policy = loadNodeLocalPolicy({ ...process.env, KORTIXD_HOME: directory })
      expect(policy).toMatchObject({ enabledCapabilities: ['filesystem'], allowedPaths: [directory], allowedCommands: ['git'], blockedCommands: ['ssh'], maxFileSize: 12, shellMaxTimeout: 14 })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('rejects a symlink policy and invalid capability values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-policy-'))
    const target = join(directory, 'target.json')
    try {
      writeFileSync(target, '{}', { mode: 0o600 })
      symlinkSync(target, join(directory, 'policy.json'))
      expect(() => loadNodeLocalPolicy({ ...process.env, KORTIXD_HOME: directory })).toThrow('regular file')
      rmSync(join(directory, 'policy.json'))
      writeFileSync(join(directory, 'policy.json'), JSON.stringify({ enabledCapabilities: ['root'] }), { mode: 0o600 })
      expect(() => loadNodeLocalPolicy({ ...process.env, KORTIXD_HOME: directory })).toThrow('unsupported')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('repairs a POSIX policy mode to 0600', () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-policy-'))
    try {
      const path = join(directory, 'policy.json')
      writeFileSync(path, '{}')
      chmodSync(path, 0o644)
      loadNodeLocalPolicy({ ...process.env, KORTIXD_HOME: directory })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
