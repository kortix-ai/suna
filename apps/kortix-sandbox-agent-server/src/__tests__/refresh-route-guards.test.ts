/**
 * Guards on the refresh path that are independent of config convergence:
 * a reboot must not reset an existing session branch, and `on_boot=1` requires
 * a direct service call.
 * Real Git repositories.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@/lib/config/config'
import type { HarnessControlOperations } from '@/harness/contract/control'
import { createPiConfigReleases } from '@/harness/pi/config-release'
import { createPiControlService } from '@/harness/pi/control'
import { KORTIX_SERVICE_CALL_HEADER } from '@/lib/kortix-api/kortix-user-context'
import { createRefreshRouter } from '@/routes/kortix/refresh'
import { commitAll, git as gitIn, initRepo, write as writeIn } from './helpers/config-release-fixtures'

let root: string
let work: string

const git = (cwd: string, ...args: string[]) => gitIn(cwd, ...args)
const write = (repo: string, rel: string, body: string) => writeIn(repo, rel, body)

function setup(_opts: { shallow: boolean }) {
  root = mkdtempSync(join(tmpdir(), 'kortix-refresh-guards-'))
  const origin = join(root, 'origin')
  work = join(root, 'work')
  initRepo(origin)
  write(origin, 'app.ts', 'export const x = 1\n')
  commitAll(origin, 'base')
  git(root, 'clone', '--quiet', `file://${origin}`, work)
  git(work, 'config', 'user.email', 't@t.co')
  git(work, 'config', 'user.name', 'T')
  git(work, 'checkout', '-q', '-b', 'ses-1111-2222')
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('reboot must not reset an existing session branch', () => {
  beforeEach(() => setup({ shallow: false }))

  test('the destructive primitive really does orphan commits (the bug)', () => {
    // Establishes the danger the fix avoids, so a future reader can see why the
    // extra rev-parse is not ceremony.
    write(work, 'agent-work.txt', 'work\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'agent work')
    const sessionTip = git(work, 'rev-parse', 'HEAD')
    git(work, 'checkout', '-q', 'main')

    git(work, 'checkout', '-B', 'ses-1111-2222')

    expect(git(work, 'rev-parse', 'HEAD')).not.toBe(sessionTip)
    expect(git(work, 'log', '--oneline', '-1')).not.toContain('agent work')
  })

  test('a plain checkout of an EXISTING branch preserves its commits', () => {
    // What the fixed code does instead.
    write(work, 'agent-work.txt', 'work\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'agent work')
    const sessionTip = git(work, 'rev-parse', 'HEAD')
    git(work, 'checkout', '-q', 'main')

    git(work, 'checkout', 'ses-1111-2222')

    expect(git(work, 'rev-parse', 'HEAD')).toBe(sessionTip)
    expect(readFileSync(join(work, 'agent-work.txt'), 'utf8')).toBe('work\n')
  })

  test('the daemon probes for the ref and only creates when it is absent', () => {
    const SRC = readFileSync(join(import.meta.dir, '..', 'services', 'workspace-provider', 'checkout.ts'), 'utf8')
    const fn = SRC.split('async function checkoutLocalSessionBranch(')[1]?.split('\n}\n')[0]
    expect(fn).toBeTruthy()
    expect(fn).toContain("'rev-parse', '--verify', '--quiet'")
    // The existing-ref path must be a plain checkout — `-B` there is the bug.
    const existingPath = (fn as string).slice((fn as string).indexOf('exists.code === 0'));
    expect(existingPath).toContain("'checkout', branch");
    // `-B` may appear EXACTLY once: the create path, reached only when the ref
    // does not exist. A second occurrence means either the existing-ref branch
    // uses it, or a failed switch falls back to it — and that fallback is
    // precisely the data loss.
    expect((fn as string).match(/'-B'/g) ?? []).toHaveLength(1);
  })
})

describe('on_boot=1 requires a DIRECT service call', () => {
  const TOKEN = 'service-key-under-test'

  function router(onBoot: () => void) {
    const cfg = { sandboxToken: TOKEN } as Config
    const control = {
      refresh: async () => ({ ok: true, repo: {}, runtime: 'ok', runtime_pid: 1 }),
    } as unknown as HarnessControlOperations
    return createRefreshRouter(cfg, control, { runSandboxOnBoot: onBoot })
  }

  test('a proxied request cannot launch the project boot command', async () => {
    let calls = 0
    const res = await router(() => calls++).request('/?on_boot=1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(403)
    expect(calls).toBe(0)
  })

  test('a direct service request launches the project boot command after refresh', async () => {
    let calls = 0
    const res = await router(() => calls++).request('/?repo=0&on_boot=1', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        [KORTIX_SERVICE_CALL_HEADER]: '1',
      },
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
    expect(await res.json()).toMatchObject({ on_boot: 'started' })
  })
})
