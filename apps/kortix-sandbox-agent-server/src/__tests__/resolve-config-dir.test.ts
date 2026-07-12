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

import { resolveOpencodeConfigDir, resolveSandboxOnBoot, type Config } from '../config'

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
    sandboxToken: undefined,
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

describe('resolveSandboxOnBoot', () => {
  test('returns null when no manifest exists', async () => {
    expect(await resolveSandboxOnBoot(cfg())).toBeNull()
  })

  test('reads sandbox.on_boot from kortix.yaml', async () => {
    writeFileSync(join(workspace, 'kortix.yaml'), 'sandbox:\n  on_boot: "pnpm dev"\n')
    expect(await resolveSandboxOnBoot(cfg())).toBe('pnpm dev')
  })

  test('reads an unquoted sandbox.on_boot from kortix.yaml', async () => {
    writeFileSync(join(workspace, 'kortix.yaml'), 'sandbox:\n  on_boot: pnpm dev\n')
    expect(await resolveSandboxOnBoot(cfg())).toBe('pnpm dev')
  })

  test('reads [sandbox] on_boot from legacy kortix.toml', async () => {
    writeFileSync(join(workspace, 'kortix.toml'), '[sandbox]\non_boot = "pnpm dev"\n')
    expect(await resolveSandboxOnBoot(cfg())).toBe('pnpm dev')
  })

  test('returns null when sandbox.on_boot is unset', async () => {
    writeFileSync(join(workspace, 'kortix.yaml'), 'sandbox:\n  cpu: 4\n')
    expect(await resolveSandboxOnBoot(cfg())).toBeNull()
  })
})
