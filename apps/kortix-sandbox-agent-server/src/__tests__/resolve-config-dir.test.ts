/**
 * resolveOpencodeConfigDir picks the opencode config dir for a sandbox. The
 * project's config lives INSIDE the cloned repo (`<projectTarget>/.kortix/
 * opencode`), so this only returns the project dir once the repo has been
 * materialized — otherwise it falls back to the baked default. The boot path
 * (main.ts) MUST therefore resolve this AFTER the clone; resolving before the
 * clone always fell back and silently dropped the project's custom agents,
 * plugins, commands and `default_agent`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveOpencodeConfigDir, type Config } from '../config'

let workspace: string
const DEFAULT_DIR = '/ephemeral/kortix-master/opencode'

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    staticPort: 3211,
    workspace,
    projectTarget: workspace,
    defaultBranch: 'main',
    branchFetchAttempts: 1,
    branchFetchDelaySec: 0,
    defaultOpencodeConfigDir: DEFAULT_DIR,
    autoClone: true,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    kortixToken: undefined,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: 'blob:none',
    ...overrides,
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'kortix-cfgdir-'))
})
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('resolveOpencodeConfigDir', () => {
  test('falls back to the baked default when the repo is not yet cloned', async () => {
    // No kortix.toml, no .kortix/opencode — i.e. the pre-clone state. This is
    // exactly the situation that produced the no-custom-agents bug.
    expect(await resolveOpencodeConfigDir(cfg())).toBe(DEFAULT_DIR)
  })

  test('returns the project config dir once the repo has opencode.jsonc', async () => {
    mkdirSync(join(workspace, '.kortix/opencode'), { recursive: true })
    writeFileSync(join(workspace, '.kortix/opencode/opencode.jsonc'), '{"default_agent":"kortix"}')
    expect(await resolveOpencodeConfigDir(cfg())).toBe(join(workspace, '.kortix/opencode'))
  })

  test('also accepts opencode.json (non-jsonc)', async () => {
    mkdirSync(join(workspace, '.kortix/opencode'), { recursive: true })
    writeFileSync(join(workspace, '.kortix/opencode/opencode.json'), '{}')
    expect(await resolveOpencodeConfigDir(cfg())).toBe(join(workspace, '.kortix/opencode'))
  })

  test('honors a custom [opencode] config_dir from kortix.toml', async () => {
    writeFileSync(join(workspace, 'kortix.toml'), '[opencode]\nconfig_dir = "config/oc"\n')
    mkdirSync(join(workspace, 'config/oc'), { recursive: true })
    writeFileSync(join(workspace, 'config/oc/opencode.jsonc'), '{}')
    expect(await resolveOpencodeConfigDir(cfg())).toBe(join(workspace, 'config/oc'))
  })

  test('falls back when the manifest points at a dir lacking an opencode config file', async () => {
    writeFileSync(join(workspace, 'kortix.toml'), '[opencode]\nconfig_dir = ".kortix/opencode"\n')
    mkdirSync(join(workspace, '.kortix/opencode'), { recursive: true })
    // dir exists but has no opencode.jsonc/json — still fall back.
    expect(await resolveOpencodeConfigDir(cfg())).toBe(DEFAULT_DIR)
  })
})
