import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeAgentEnvFile } from '../agent-env-file'
import { createProjectEnvStore } from '../project-env'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-agentenv-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function paths() {
  return { json: join(dir, 'agent-env.json'), sh: join(dir, 'agent-env.sh') }
}

describe('writeAgentEnvFile', () => {
  test('writes the live env snapshot as 0600 JSON', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-boot',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'secret',
    } as NodeJS.ProcessEnv)
    const { json } = paths()

    expect(writeAgentEnvFile(store, paths())).toBe(true)

    const parsed = JSON.parse(readFileSync(json, 'utf8'))
    expect(parsed).toMatchObject({
      env: { API_KEY: 'secret' },
      names: ['API_KEY'],
      revision: 'rev-boot',
    })
    expect(statSync(json).mode & 0o777).toBe(0o600)
  })

  test('writes a 0600 shell file that exports each secret', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'secret',
    } as NodeJS.ProcessEnv)
    const { sh } = paths()

    writeAgentEnvFile(store, paths())

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain("export API_KEY='secret'")
    expect(statSync(sh).mode & 0o777).toBe(0o600)
  })

  test('shell file is injection-safe — values are single-quote escaped', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'EVIL',
      EVIL: "$(touch /tmp/pwned); a'b",
    } as NodeJS.ProcessEnv)
    const { sh } = paths()

    writeAgentEnvFile(store, paths())

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain(`export EVIL='$(touch /tmp/pwned); a'\\''b'`)
  })

  test('reflects rotation and unsets a revoked secret in both files', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY,OLD',
      API_KEY: 'v1',
      OLD: 'gone-soon',
    } as NodeJS.ProcessEnv)
    const { json, sh } = paths()

    store.apply({ revision: 'r2', env: { API_KEY: 'v2' }, names: ['API_KEY'] })
    writeAgentEnvFile(store, paths(), {
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY,OLD',
    } as NodeJS.ProcessEnv)

    const parsed = JSON.parse(readFileSync(json, 'utf8'))
    expect(parsed.env).toEqual({ API_KEY: 'v2' })
    expect(parsed.revision).toBe('r2')

    const body = readFileSync(sh, 'utf8')
    expect(body).toContain("export API_KEY='v2'")
    expect(body).toContain('unset OLD')
  })
})
