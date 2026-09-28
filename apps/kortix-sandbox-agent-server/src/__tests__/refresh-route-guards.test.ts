/**
 * Guards on the refresh path that are independent of config convergence:
 * a reboot must not reset an existing session branch, and `base=1` (the
 * destructive branch reset) requires a direct service call.
 * Real Git repositories.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import { createOpenCodeQuickQueueInterrupt } from '../harness/open-code/background'
import { createOpenCodeControlService } from '../harness/open-code/control'
import type { Opencode } from '../harness/open-code/lifecycle'
import { KORTIX_SERVICE_CALL_HEADER } from '../kortix-user-context'
import { createRefreshRouter } from '../routes/refresh'
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
    const SRC = readFileSync(join(import.meta.dir, '..', 'git.ts'), 'utf8')
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

/**
 * `base=1` is the branch reset. Only the service credential may ask for it.
 *
 * `syncWorkspaceToBase` force-resets the session's own branch onto the base tip
 * and deletes the files its commits introduced. The API's reload deliberately
 * refuses to send it — but the endpoint is reachable through the user-facing
 * sandbox proxy, which blocks exactly one daemon path (`/kortix/env`) and not
 * this one. So any principal who could see the session could wipe its history
 * with a single request, as could the in-box agent via a prompt-injected `curl`
 * against localhost.
 *
 * Its only legitimate caller is the warm-session workspace refresh, at session
 * CREATE, holding the service key.
 */
/**
 * `base=1` — the destructive branch reset — must be unreachable from the proxy.
 *
 * These drive the real Hono route rather than asserting on its source, because
 * the FIRST version of this gate passed a source-shaped test while protecting
 * nothing. It checked only the bearer, and the preview proxy authenticates every
 * request it relays — an ordinary user's included — with the target sandbox's
 * own service key. So `serviceAuthenticated` was true for exactly the traffic
 * the gate existed to stop, and no amount of grepping the file would say so.
 *
 * The shape below named "a proxied user request" is that case, pinned.
 */
describe('base=1 requires a DIRECT service call', () => {
  const TOKEN = 'service-key-under-test'

  function router() {
    // The rejection paths return before any repo or runtime work, so a config
    // carrying just the token is all the route reads on these paths.
    const cfg = { sandboxToken: TOKEN, opencodeInternalPort: 4096, opencodeStandbyPort: 4097, defaultOpencodeConfigDir: '/ephemeral/opencode' } as unknown as Config
    const opencode = {
      restart: async () => {
        throw new Error('restart must not run on a refused request')
      },
      getState: () => 'ready',
      getPid: () => 1,
    } as unknown as Opencode
    return createRefreshRouter(cfg, createOpenCodeControlService(opencode, createOpenCodeQuickQueueInterrupt(opencode, cfg)).bind({ cfg }))
  }

  async function post(path: string, headers: Record<string, string>) {
    return router().request(path, { method: 'POST', headers })
  }

  test('a request shaped exactly like a proxied user request is refused', async () => {
    // What the proxy actually sends: the sandbox's service key as the bearer,
    // and NO service-call header (it strips that name from every forward).
    // This is the request that used to be accepted.
    const res = await post('/?base=1', { Authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'BASE_RESET_FORBIDDEN' })
  })

  test('the service-call header alone does not authorize it', async () => {
    // The header is unauthenticated on its own — anyone can name a header. It
    // proves the HOP, never the caller, so it must not substitute for the token.
    const res = await post('/?base=1', { [KORTIX_SERVICE_CALL_HEADER]: '1' })
    expect(res.status).toBe(401)
  })

  test('a direct platform call — both proofs — is not refused', async () => {
    const res = await post('/?base=1', {
      Authorization: `Bearer ${TOKEN}`,
      [KORTIX_SERVICE_CALL_HEADER]: '1',
    })
    // It proceeds into the repo work and fails there (this config has no
    // workspace). The assertion that matters is that it was not turned away by
    // the gate — otherwise the warm-session refresh at session create breaks.
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  test('the refusal happens before any repo work', async () => {
    // Refusing after the reset would be no protection at all. `syncWorkspaceToBase`
    // would throw on this config; a 403 proves it was never reached.
    const res = await post('/?base=1', { Authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(403)
  })

  test('an ordinary refresh is still open to a proxied caller', async () => {
    // The gate must be specific to the destructive flag. A session owner pulling
    // their own workspace, or the API's reload sending `config_dir=1`, is
    // legitimate and must keep working without the direct-call header.
    for (const path of ['/']) {
      const res = await post(path, { Authorization: `Bearer ${TOKEN}` })
      expect(res.status).not.toBe(403)
    }
  })
})
