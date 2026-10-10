import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reloadSessionEnv } from '@/harness/open-code/warm-seed'

// The seam: `KORTIX_PT_ENV_PATH` decides which env file `reloadSessionEnv()`
// reads. A Kortix box has a real /etc/pt-env carrying this session's branch,
// tokens and credentials, so a rig must be able to point the read at an absent
// path and assert `reloadSessionEnv()` touches nothing (host-health.ts honors
// the same seam; see preload-isolated-home.ts).

const ABSENT_PT_ENV = join(tmpdir(), 'warm-seed-reload-session-env-absent')
const SENTINEL_KEY = 'KORTIX_TEST_PT_ENV_SENTINEL'
let dir: string
let envBefore: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'warm-seed-reload-session-env-'))
  envBefore = { ...process.env }
})

afterEach(() => {
  // The code under test mutates process.env — on a Kortix box that is the
  // /etc/pt-env leak this seam exists to prevent — so restore the full env by
  // diff, not just the keys this file set itself.
  for (const key of Object.keys(process.env)) {
    if (!(key in envBefore)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(envBefore)) {
    if (process.env[key] !== value) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('reloadSessionEnv honors KORTIX_PT_ENV_PATH', () => {
  test('reads the file the seam names, not the hardcoded /etc/pt-env', () => {
    const file = join(dir, 'pt-env')
    writeFileSync(file, `${SENTINEL_KEY}=from-seam\n`, 'utf8')
    delete process.env[SENTINEL_KEY]
    process.env.KORTIX_PT_ENV_PATH = file

    reloadSessionEnv()

    expect(process.env[SENTINEL_KEY]).toBe('from-seam')
  })

  test('an absent seam path mutates no env, even when /etc/pt-env exists', () => {
    process.env.KORTIX_PT_ENV_PATH = ABSENT_PT_ENV
    const before = { ...process.env }

    reloadSessionEnv()

    // Assert on key names only: a failure must never echo the box's real env
    // values (that is exactly the leak this seam prevents).
    const added = Object.keys(process.env).filter((key) => !(key in before))
    const changed = Object.keys(before).filter((key) => process.env[key] !== before[key])
    expect(added).toEqual([])
    expect(changed).toEqual([])
  })
})
