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

describe('writeAgentEnvFile', () => {
  test('writes the live env snapshot as 0600 JSON', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-boot',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'secret',
    } as NodeJS.ProcessEnv)
    const file = join(dir, 'nested', 'agent-env.json')

    expect(writeAgentEnvFile(store, file)).toBe(true)

    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed).toMatchObject({
      env: { API_KEY: 'secret' },
      names: ['API_KEY'],
      revision: 'rev-boot',
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('reflects an applied env change (rotation + revocation)', () => {
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY,OLD',
      API_KEY: 'v1',
      OLD: 'gone-soon',
    } as NodeJS.ProcessEnv)
    const file = join(dir, 'agent-env.json')

    store.apply({ revision: 'r2', env: { API_KEY: 'v2' }, names: ['API_KEY'] })
    writeAgentEnvFile(store, file)

    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.env).toEqual({ API_KEY: 'v2' })
    expect(parsed.names).toEqual(['API_KEY'])
    expect(parsed.revision).toBe('r2')
  })
})
