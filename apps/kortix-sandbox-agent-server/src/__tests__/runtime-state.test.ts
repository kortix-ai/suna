import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY,
  openCodeSeedBakedPinPath,
  openCodeSessionPinPath,
  resolveKortixRuntimeStateDirectory,
  resolveOpenCodeAuditSpoolPath,
} from '@/harness/open-code/runtime-state'

let stateDir: string
let priorStateDir: string | undefined

beforeEach(() => {
  priorStateDir = process.env.KORTIX_RUNTIME_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-runtime-state-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
})

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.KORTIX_RUNTIME_STATE_DIR
  else process.env.KORTIX_RUNTIME_STATE_DIR = priorStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

describe('sandbox runtime state paths', () => {
  test('keeps every default under the kortix-owned home directory', () => {
    delete process.env.KORTIX_RUNTIME_STATE_DIR
    expect(DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY).toBe('/home/kortix/.local/state/kortix')
    expect(openCodeSessionPinPath()).toBe('/home/kortix/.local/state/kortix/opencode-session-id')
    expect(openCodeSeedBakedPinPath()).toBe('/home/kortix/.local/state/kortix/opencode-seed-baked-id')
    expect(resolveOpenCodeAuditSpoolPath({})).toBe(
      '/home/kortix/.local/state/kortix/opencode-audit-spool.json',
    )
  })

  test('supports one shared state-directory override', () => {
    const env = { KORTIX_RUNTIME_STATE_DIR: '/tmp/kortix-runtime-test' }
    expect(resolveKortixRuntimeStateDirectory(env)).toBe('/tmp/kortix-runtime-test')
    expect(resolveOpenCodeAuditSpoolPath(env)).toBe(
      '/tmp/kortix-runtime-test/opencode-audit-spool.json',
    )
    expect(openCodeSessionPinPath()).toBe(join(stateDir, 'opencode-session-id'))
    expect(openCodeSeedBakedPinPath()).toBe(join(stateDir, 'opencode-seed-baked-id'))
  })
})
