/**
 * resolveOpencodeConfigDir picks the opencode config dir for a sandbox. The
 * project's config lives INSIDE the cloned repo (`<projectTarget>/.kortix/
 * opencode`), so this only returns the project dir once the repo has been
 * materialized — otherwise it falls back to the baked default. The boot path
 * (harness/open-code/boot.ts) MUST therefore resolve this AFTER the clone; resolving before the
 * clone always fell back and silently dropped the project's custom agents,
 * plugins, commands and `default_agent`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../config'
import { loadOpenCodeConfig, requireOpenCodeConfig, resolveOpencodeConfigDir, type OpenCodeConfig as Config } from '../harness/open-code/config'

let workspace: string
const DEFAULT_DIR = '/ephemeral/kortix-master/opencode'

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
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
    sandboxToken: undefined,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: 'blob:none',
    compiledBootMode: 'off',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
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

  test('honors a custom opencode.config_dir from kortix.yaml', async () => {
    writeFileSync(join(workspace, 'kortix.yaml'), 'opencode:\n  config_dir: config/oc\n')
    mkdirSync(join(workspace, 'config/oc'), { recursive: true })
    writeFileSync(join(workspace, 'config/oc/opencode.jsonc'), '{}')
    expect(await resolveOpencodeConfigDir(cfg())).toBe(join(workspace, 'config/oc'))
  })

  test('honors a custom [opencode] config_dir from legacy kortix.toml', async () => {
    writeFileSync(join(workspace, 'kortix.toml'), '[opencode]\nconfig_dir = "config/oc"\n')
    mkdirSync(join(workspace, 'config/oc'), { recursive: true })
    writeFileSync(join(workspace, 'config/oc/opencode.jsonc'), '{}')
    expect(await resolveOpencodeConfigDir(cfg())).toBe(join(workspace, 'config/oc'))
  })

  test('prefers kortix.yaml over a legacy kortix.toml when both exist', async () => {
    writeFileSync(join(workspace, 'kortix.yaml'), 'opencode:\n  config_dir: yaml/oc\n')
    writeFileSync(join(workspace, 'kortix.toml'), '[opencode]\nconfig_dir = "toml/oc"\n')
    mkdirSync(join(workspace, 'yaml/oc'), { recursive: true })
    writeFileSync(join(workspace, 'yaml/oc/opencode.jsonc'), '{}')
    expect(await resolveOpencodeConfigDir(cfg())).toBe(join(workspace, 'yaml/oc'))
  })

  test('falls back when the manifest points at a dir lacking an opencode config file', async () => {
    writeFileSync(join(workspace, 'kortix.yaml'), 'opencode:\n  config_dir: .kortix/opencode\n')
    mkdirSync(join(workspace, '.kortix/opencode'), { recursive: true })
    // dir exists but has no opencode.jsonc/json — still fall back.
    expect(await resolveOpencodeConfigDir(cfg())).toBe(DEFAULT_DIR)
  })
})

describe('native configuration behind the host boundary', () => {
  test('an empty environment yields the flat defaults', () => {
    const native = requireOpenCodeConfig(loadConfig({}))
    expect(native).toMatchObject({
      servicePort: 8000,
      staticPort: 3211,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
      defaultOpencodeConfigDir: DEFAULT_DIR,
    })
    // The API's boot-time config-dir HINT is gone: the boot path asks the API
    // for the release itself, so no second, earlier answer exists to disagree.
    expect('opencodeConfigDirHint' in native).toBe(false)
  })

  test('reads supplied host and native overrides', () => {
    const native = loadOpenCodeConfig({
      KORTIX_SERVICE_PORT: '8123',
      KORTIX_OPENCODE_INTERNAL_PORT: '4123',
      KORTIX_OPENCODE_STANDBY_PORT: '4124',
      KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: '/custom/native/config',
      KORTIX_OPENCODE_CONFIG_DIR_HINT: '.kortix/opencode',
    })
    expect(native).toMatchObject({
      servicePort: 8123,
      opencodeInternalPort: 4123,
      opencodeStandbyPort: 4124,
      defaultOpencodeConfigDir: '/custom/native/config',
    })
    // A stale hint from an older API is READ BY NOTHING, so it cannot steer a
    // boot any more.
    expect('opencodeConfigDirHint' in native).toBe(false)
    expect(() => loadOpenCodeConfig({ KORTIX_OPENCODE_INTERNAL_PORT: 'invalid' })).toThrow()
  })
})
