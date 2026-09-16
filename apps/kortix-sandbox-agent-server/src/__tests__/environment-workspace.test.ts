import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { prepareEnvironmentWorkspace } from '../environment-workspace'
import { runGit } from '../git'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('environment workspace ownership', () => {
  test('adopts an existing workspace without fetching or replacing uncommitted files or the branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'environment-workspace-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await runGit(['init', '-b', 'user-selected-branch'], { cwd: workspace })
    await writeFile(join(workspace, 'working.txt'), 'uncommitted work')
    const cfg = loadConfig({
      KORTIX_WORKSPACE: workspace, KORTIX_PROJECT_TARGET: workspace,
      KORTIX_PROJECT_AUTO_CLONE: '1', KORTIX_SESSION_BRANCH_RESTORE: '1',
      KORTIX_SESSION_FRESH: '1', KORTIX_BRANCH_NAME: 'session-branch',
      KORTIX_REPO_URL: join(root, 'unreachable.git'), KORTIX_PROJECT_ID: 'project',
    })
    const env = { KORTIX_SESSION_ID: 'session', KORTIX_AGENT_STATE_DIR: join(root, 'state') }
    await prepareEnvironmentWorkspace(cfg, { ...env, KORTIX_ENVIRONMENT_REUSE_WORKSPACE: '1' })
    await prepareEnvironmentWorkspace(cfg, env)
    expect(await readFile(join(workspace, 'working.txt'), 'utf8')).toBe('uncommitted work')
    expect((await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: workspace })).stdout.trim()).toBe('user-selected-branch')
    expect(JSON.parse(await readFile(join(root, 'state/workspace.json'), 'utf8'))).toMatchObject({ sessionId: 'session', projectId: 'project' })
  })

  test('missing storage during recovery fails instead of creating an empty replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'environment-workspace-'))
    roots.push(root)
    const workspace = join(root, 'missing')
    const cfg = loadConfig({ KORTIX_WORKSPACE: workspace })
    await expect(prepareEnvironmentWorkspace(cfg, { KORTIX_ENVIRONMENT_REUSE_WORKSPACE: '1' })).rejects.toThrow()
  })
})
