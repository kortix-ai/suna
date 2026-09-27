/**
 * The daemon's environment contract (`src/config.ts`): what each `KORTIX_*`
 * variable the API sets turns into, and the defaults a box boots with when it
 * is absent. One table, so a changed default or a dropped mapping fails one
 * named row.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig, resolveSandboxOnBoot } from '../config'

const BASE_ENV = { KORTIX_WORKSPACE: '/workspace', KORTIX_REPO_URL: 'https://example.test/r.git' }

describe('loadConfig env contract', () => {
  test.each([
    // Defaults a box boots with.
    ['clone depth defaults to a shallow depth-1 clone', {}, { cloneDepth: 1 }],
    ['no partial-clone filter by default (measured slower)', {}, { cloneFilter: '' }],
    ['compiled boot defaults to off', {}, { compiledBootMode: 'off' }],
    ['the one-time branch restore is off by default', {}, { sessionBranchRestore: false }],
    // Mappings.
    ['depth 0 opts back into a full-history clone', { KORTIX_CLONE_DEPTH: '0' }, { cloneDepth: 0 }],
    ['an explicit depth is honoured', { KORTIX_CLONE_DEPTH: '25' }, { cloneDepth: 25 }],
    ['compiled boot mode shadow', { KORTIX_COMPILED_BOOT_MODE: 'shadow' }, { compiledBootMode: 'shadow' }],
    ['compiled boot mode prefer', { KORTIX_COMPILED_BOOT_MODE: 'prefer' }, { compiledBootMode: 'prefer' }],
    ['compiled boot mode required', { KORTIX_COMPILED_BOOT_MODE: 'required' }, { compiledBootMode: 'required' }],
    ['the sandbox credential comes from KORTIX_TOKEN', { KORTIX_TOKEN: 'sandbox-token' }, { sandboxToken: 'sandbox-token' }],
    ['KORTIX_SESSION_BRANCH_RESTORE=1 arms the one-time branch restore', { KORTIX_SESSION_BRANCH_RESTORE: '1' }, { sessionBranchRestore: true }],
    [
      'the fast-boot delta bundle and its parent commit reach the config',
      {
        KORTIX_GIT_DELTA_BUNDLE_BASE64: 'R0lUIEJVTkRMRQ==',
        KORTIX_GIT_DELTA_PARENT_SHA: 'a'.repeat(40),
        KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: 'dHJlZSBkZWFkYmVlZgo=',
      },
      {
        gitDeltaBundleBase64: 'R0lUIEJVTkRMRQ==',
        gitDeltaParentSha: 'a'.repeat(40),
        gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
      },
    ],
  ] as const)('%s', (_name, env, expected) => {
    expect(loadConfig({ ...BASE_ENV, ...env } as NodeJS.ProcessEnv)).toMatchObject(expected)
  })

  test.each([
    ['a negative clone depth', { KORTIX_CLONE_DEPTH: '-1' }],
    ['an unknown compiled boot mode', { KORTIX_COMPILED_BOOT_MODE: 'enabled' }],
  ])('rejects %s instead of passing it to git', (_name, env) => {
    expect(() => loadConfig({ ...BASE_ENV, ...env } as NodeJS.ProcessEnv)).toThrow()
  })
})

describe('resolveSandboxOnBoot', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'kortix-on-boot-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  const onBoot = () =>
    resolveSandboxOnBoot(loadConfig({ KORTIX_WORKSPACE: workspace, KORTIX_PROJECT_TARGET: workspace } as NodeJS.ProcessEnv))

  test.each([
    ['kortix.yaml', 'sandbox:\n  on_boot: "pnpm dev"\n', 'pnpm dev'],
    ['kortix.yaml', 'sandbox:\n  on_boot: pnpm dev\n', 'pnpm dev'],
    ['kortix.toml', '[sandbox]\non_boot = "pnpm dev"\n', 'pnpm dev'],
    ['kortix.yaml', 'sandbox:\n  cpu: 4\n', null],
  ])('%s %j → %j', async (file, body, expected) => {
    writeFileSync(join(workspace, file), body)
    expect(await onBoot()).toBe(expected)
  })

  test('no manifest → null', async () => {
    expect(await onBoot()).toBeNull()
  })
})
