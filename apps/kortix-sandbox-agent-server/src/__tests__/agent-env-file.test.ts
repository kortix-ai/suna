import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { shredAgentEnvFile, writeAgentEnvFile } from '../agent-env-file'
import { createProjectEnvStore } from '../project-env'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-agentenv-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function shPath() {
  return join(dir, 'agent-env.sh')
}

describe('writeAgentEnvFile', () => {
  test('writes a 0600 shell file that exports each secret', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'secret',
    } as NodeJS.ProcessEnv)
    const sh = shPath()

    expect(writeAgentEnvFile(store, { sh })).toBe(true)

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain("export API_KEY='secret'")
    expect(statSync(sh).mode & 0o777).toBe(0o600)
  })

  test('injection-safe — values are single-quote escaped', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'EVIL',
      EVIL: "$(touch /tmp/pwned); a'b",
    } as NodeJS.ProcessEnv)
    const sh = shPath()

    writeAgentEnvFile(store, { sh })

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain(`export EVIL='$(touch /tmp/pwned); a'\\''b'`)
  })

  test('skips a value containing a NUL byte rather than breaking the file', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'GOOD,BADNUL',
      GOOD: 'ok',
      BADNUL: `x${String.fromCharCode(0)}y`,
    } as NodeJS.ProcessEnv)
    const sh = shPath()

    writeAgentEnvFile(store, { sh })

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain("export GOOD='ok'")
    expect(body).not.toContain('BADNUL')
    expect(body.includes(String.fromCharCode(0))).toBe(false)
  })

  test('drops reserved/dangerous names even if they reach the store', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'GOOD,PATH,LD_PRELOAD,BASH_ENV',
      GOOD: 'ok',
      PATH: '/evil',
      LD_PRELOAD: '/evil.so',
      BASH_ENV: '/evil.sh',
    } as NodeJS.ProcessEnv)
    const sh = shPath()

    writeAgentEnvFile(store, { sh })

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain("export GOOD='ok'")
    expect(body).not.toContain('/evil')
    expect(body).not.toContain('LD_PRELOAD')
  })

  test('rotation + revocation: exports new value, unsets a removed boot secret', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY,OLD',
      API_KEY: 'v1',
      OLD: 'gone-soon',
    } as NodeJS.ProcessEnv)
    const sh = shPath()

    store.apply({ revision: 'r2', env: { API_KEY: 'v2' }, names: ['API_KEY'] })
    writeAgentEnvFile(store, {
      sh,
      bootEnv: { KORTIX_PROJECT_SECRET_NAMES: 'API_KEY,OLD' } as NodeJS.ProcessEnv,
    })

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain("export API_KEY='v2'")
    expect(body).toContain('unset OLD')
  })

  test('shredAgentEnvFile removes the file', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'secret',
    } as NodeJS.ProcessEnv)
    const sh = shPath()
    writeAgentEnvFile(store, { sh })
    expect(existsSync(sh)).toBe(true)

    shredAgentEnvFile(sh)
    expect(existsSync(sh)).toBe(false)
  })
})
