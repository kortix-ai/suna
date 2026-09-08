import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { createExecutionOnlyRuntime } from '../execution-only'
import { runGit } from '../git'
import { createProjectEnvStore } from '../project-env'
import { buildOpencodeApp } from '../proxy'

const token = 'execution-environment-test-token'
let workspace: string
let app: ReturnType<typeof buildOpencodeApp>
let headers: Record<string, string>
const git = async (...args: string[]) => {
  const result = await runGit(args, { cwd: workspace })
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kortix-execution-'))
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Runtime Test')
  await git('config', 'user.email', 'runtime@example.test')
  await writeFile(join(workspace, 'note.txt'), 'before\n')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  const cfg = loadConfig({ KORTIX_WORKLOAD: 'environment', KORTIX_WORKSPACE: workspace, KORTIX_PROJECT_TARGET: workspace, KORTIX_TOKEN: token })
  app = buildOpencodeApp(cfg, createExecutionOnlyRuntime(), Date.now(), {
    repoMaterializationError: null, timeline: [], workspaceReady: true,
  }, createProjectEnvStore({}), null, undefined, join(workspace, 'env.sh'))
  const payload = Buffer.from(JSON.stringify({ userId: 'user', exp: Math.floor(Date.now() / 1000) + 120 })).toString('base64url')
  headers = { 'X-Kortix-User-Context': `${payload}.${createHmac('sha256', token).update(payload).digest('base64url')}` }
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('execution-only environment', () => {
  test('reports ready without contacting or starting an agent runtime', async () => {
    const response = await app.request('/kortix/health?turn=1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ runtimeReady: true, workload: 'environment', opencode: 'disabled', opencode_pid: null, opencode_port: null })
    for (const route of ['/session', '/kortix/opencode/state', '/kortix/part/message', '/kortix/abort']) {
      const response = await app.request(route, { headers })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'ENVIRONMENT_AGENT_RUNTIME_DISABLED' })
    }
  })

  test('serves authenticated workspace identity without OpenCode', async () => {
    expect((await app.request('/project/current')).status).toBe(401)
    const current = await (await app.request('/project/current', { headers })).json()
    expect(current).toMatchObject({ worktree: workspace, vcs: 'git', sandboxes: [] })
    expect(await (await app.request('/project', { headers })).json()).toEqual([current])
    expect(await (await app.request('/path', { headers })).json()).toMatchObject({ worktree: workspace, directory: workspace })
    expect(await (await app.request('/vcs', { headers })).json()).toMatchObject({ branch: 'main', default_branch: 'main' })
    expect((await app.request('/vcs?directory=/etc', { headers })).status).toBe(400)
  })

  test('separates branch commits from working changes and preserves unusual file names', async () => {
    await git('switch', '-c', 'session')
    await writeFile(join(workspace, 'note.txt'), 'committed\n')
    await git('commit', '-am', 'session change')
    expect(await (await app.request('/vcs/diff?mode=git', { headers })).json()).toEqual([])
    const branch = await (await app.request('/vcs/diff?mode=branch', { headers })).json()
    expect(branch).toEqual([expect.objectContaining({ file: 'note.txt', additions: 1, deletions: 1, patch: expect.stringContaining('+committed') })])
    await writeFile(join(workspace, 'spaces\tand\nlines.txt'), 'one\ntwo\n')
    await writeFile(join(workspace, 'image.bin'), Buffer.from([0, 1, 2]))
    const changes = await (await app.request('/vcs/status', { headers })).json()
    expect(changes).toContainEqual({ file: 'spaces\tand\nlines.txt', additions: 2, deletions: 0, status: 'added' })
    expect(changes).toContainEqual({ file: 'image.bin', additions: 0, deletions: 0, status: 'added' })
  })

  test('reads raw patches and applies them only to a clean workspace', async () => {
    await writeFile(join(workspace, 'note.txt'), 'after\n')
    const patch = await (await app.request('/vcs/diff/raw', { headers })).json()
    expect(patch).toContain('+after')
    const apply = () => app.request('/vcs/apply', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }) })
    expect((await apply()).status).toBe(400)
    await git('restore', 'note.txt')
    expect(await (await apply()).json()).toEqual({ applied: true })
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('after\n')
  })

  test('bounds Git output and reports a terminated command as a failure', async () => {
    await writeFile(join(workspace, 'large.txt'), 'a'.repeat(100000))
    await expect(runGit(['diff', '--no-index', '/dev/null', 'large.txt'], { cwd: workspace, maxOutputBytes: 1000 })).rejects.toThrow('Git output exceeds 1000 bytes')
    const killed = await runGit(['-c', 'alias.delay=!sleep 2', 'delay'], { cwd: workspace, timeoutMs: 20 })
    expect(killed.code).not.toBe(0)
  })

  test('updates shell secrets without starting OpenCode even when model refresh is requested', async () => {
    const response = await app.request('/kortix/env', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 'test', env: { EXAMPLE_SECRET: 'fixture' }, refreshModels: true }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ opencode: 'disabled', opencode_pid: null })
    expect(await readFile(join(workspace, 'env.sh'), 'utf8')).toContain('EXAMPLE_SECRET')
  })

  test('the real daemon ignores inherited OpenCode warm-seed and initial-session flags', async () => {
    await writeFile(join(workspace, 'kortix.yaml'), 'kortix_version: 3\nsandbox:\n  on_boot: \"exit 1\"\n')
    const home = join(workspace, 'home')
    const bin = join(home, 'bin')
    await mkdir(bin, { recursive: true })
    const marker = join(home, 'opencode-started')
    await writeFile(join(bin, 'opencode'), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`)
    await chmod(join(bin, 'opencode'), 0o755)
    const reserve = () => Bun.serve({ port: 0, fetch: () => new Response('reserved') })
    const listener = reserve()
    const staticListener = reserve()
    const port = listener.port!
    const staticPort = staticListener.port!
    listener.stop(true)
    staticListener.stop(true)
    const child = Bun.spawn([process.execPath, new URL('../main.ts', import.meta.url).pathname], {
      cwd: workspace,
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: home,
        KORTIX_WORKLOAD: 'environment', KORTIX_WARM_SEED: '1',
        KORTIX_BOOTSTRAP_OPENCODE_SESSION: '1', KORTIX_TOKEN: token,
        KORTIX_SERVICE_PORT: String(port), KORTIX_STATIC_PORT: String(staticPort),
        KORTIX_WORKSPACE: workspace, KORTIX_PROJECT_TARGET: workspace,
        KORTIX_DAEMON_LOG_FILE: 'off', KORTIX_RUNTIME_ASSETS_ENABLED: '0',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      let health: Record<string, unknown> | null = null
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/kortix/health`, { signal: AbortSignal.timeout(500) })
          health = await response.json() as Record<string, unknown>
          if (health.runtimeReady === true) break
        } catch {}
        await Bun.sleep(50)
      }
      expect(health).toMatchObject({ runtimeReady: true, workload: 'environment', opencode: 'disabled', opencode_pid: null, opencode_session_required: false })
      const response = await fetch(`http://127.0.0.1:${port}/file/content?path=note.txt`, { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ content: 'before\n' })
      await expect(access(marker)).rejects.toThrow()
      await expect(access(join(home, '.local/share/opencode/opencode.db'))).rejects.toThrow()
    } finally {
      child.kill('SIGTERM')
      await child.exited
      const logs = `${await output}\n${await errors}`
      expect(logs).not.toContain('[seed]')
      expect(logs).not.toContain('opencode-spawned')
      expect(logs).not.toContain('[environment] workspace setup failed')
    }
  }, 15000)
})
