import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'bun:test'

import type { Config } from '../config'
import {
  configureGitCredentialHelper,
  configureRepoCredentialHelper,
  resolveGitCredentialOutput,
} from '../git'

const execFileAsync = promisify(execFile)

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: 'proj-1',
    apiUrl: undefined,
    repoUrl: 'https://api.kortix.test/v1/git/proj-1.git',
    branchName: 'session-xyz',
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: 'kortix_sb_secret',
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    compiledBootMode: 'off',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
    ...over,
  }
}

describe('git credential helper', () => {
  it('returns only KORTIX_TOKEN for the Kortix Git proxy', async () => {
    const out = await resolveGitCredentialOutput(baseConfig({ apiUrl: 'https://api.kortix.test/v1' }))
    expect(out).toBe('username=x-access-token\npassword=kortix_sb_secret\n')
  })

  it('refuses a direct network Git origin instead of fetching its credential', async () => {
    const out = await resolveGitCredentialOutput(baseConfig({ repoUrl: 'https://git.example.test/repo' }))
    expect(out).toBeNull()
  })

  it('returns null when token/project/api are not all present', async () => {
    expect(await resolveGitCredentialOutput(baseConfig({ apiUrl: undefined }))).toBeNull()
    expect(await resolveGitCredentialOutput(baseConfig({ projectId: undefined }))).toBeNull()
    expect(await resolveGitCredentialOutput(baseConfig({ sandboxToken: undefined }))).toBeNull()
  })

  it('configures git with a host-scoped credential helper pointing at this binary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kortix-cred-home-'))
    try {
      await configureGitCredentialHelper(baseConfig(), home)
      const env = { ...process.env, HOME: home }
      const { stdout: helper } = await execFileAsync(
        'git',
        ['config', '--global', '--get', 'credential.https://api.kortix.test.helper'],
        { env, encoding: 'utf8' },
      )
      expect(helper.trim()).toContain('git-credential')
      expect(helper.trim().startsWith('!')).toBe(true)
      const { stdout: user } = await execFileAsync(
        'git',
        ['config', '--global', '--get', 'credential.https://api.kortix.test.username'],
        { env, encoding: 'utf8' },
      )
      expect(user.trim()).toBe('x-access-token')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('is idempotent across reboots (no duplicate helper lines)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kortix-cred-home-'))
    try {
      const cfg = baseConfig()
      await configureGitCredentialHelper(cfg, home)
      await configureGitCredentialHelper(cfg, home)
      const env = { ...process.env, HOME: home }
      const { stdout } = await execFileAsync(
        'git',
        ['config', '--global', '--get-all', 'credential.https://api.kortix.test.helper'],
        { env, encoding: 'utf8' },
      )
      expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('configures the helper repo-locally (HOME-independent) on the materialized repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-cred-repo-'))
    try {
      await execFileAsync('git', ['init', '-q', dir], { encoding: 'utf8' })
      await configureRepoCredentialHelper(baseConfig(), dir)
      // Read with an UNRELATED HOME to prove the config lives in the repo, not
      // in any global ~/.gitconfig.
      const env = { ...process.env, HOME: '/nonexistent-home-for-test' }
      const { stdout } = await execFileAsync(
        'git',
        ['-C', dir, 'config', '--local', '--get', 'credential.https://api.kortix.test.helper'],
        { env, encoding: 'utf8' },
      )
      expect(stdout.trim()).toContain('git-credential')
      const { stdout: user } = await execFileAsync(
        'git',
        ['-C', dir, 'config', '--local', '--get', 'credential.https://api.kortix.test.username'],
        { env, encoding: 'utf8' },
      )
      expect(user.trim()).toBe('x-access-token')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('repo-local config is a no-op when the repo is not materialized', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-cred-norepo-'))
    try {
      // No `git init` — there's no .git here.
      await configureRepoCredentialHelper(baseConfig(), dir)
      const res = await execFileAsync('git', ['-C', dir, 'config', '--local', '--get', 'credential.https://api.kortix.test.helper'], { encoding: 'utf8' })
        .then(() => ({ ok: true }))
        .catch(() => ({ ok: false }))
      expect(res.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips configuration for a non-managed (no repo) sandbox', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kortix-cred-home-'))
    try {
      await configureGitCredentialHelper(baseConfig({ repoUrl: undefined }), home)
      const env = { ...process.env, HOME: home }
      const res = await execFileAsync(
        'git',
        ['config', '--global', '--get', 'credential.https://api.kortix.test.helper'],
        { env, encoding: 'utf8' },
      ).catch((err: { code?: number }) => ({ code: err.code }))
      // `git config --get` exits 1 when the key is absent.
      expect('code' in res ? res.code : 0).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
