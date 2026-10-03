import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '@/lib/config/config'
import type { OpenCodeConfig } from '@/harness/open-code/config'
import type { ProjectEnvStore } from '@/services/sandbox-env/project-env'
import type { OpenCodeBootState } from '@/harness/open-code/boot-state'
import { requireOpenCodeConfig } from '@/harness/open-code/config'
import type { Opencode } from '@/harness/open-code/lifecycle'
import { composeOpenCodeHarnessService } from '@/harness/open-code/service'
import { buildDaemonApp } from '@/app/server'
import type { PtyRegistry } from '@/routes/kortix/pty'

/** The default workspace/project target for tests that don't override them.
 *  A real empty directory, never the agent box's own `/workspace`: that path
 *  is empty on a CI runner (the tests were written against that absence) but
 *  is a live git checkout on a Kortix box, which turns "no repo here" flows
 *  into real git work. One dir per process; tests that need isolation pass
 *  their own via `over`. */
const DEFAULT_TEST_WORKSPACE = mkdtempSync(join(tmpdir(), 'kortix-opencode-harness-'))

/** The production daemon app over the production service composition; only
 *  the native OpenCode lifecycle is substituted. */
export function buildOpenCodeTestApp(
  cfg: Config,
  lifecycle: Opencode,
  bootTime: number,
  bootState?: OpenCodeBootState,
  projectEnv?: ProjectEnvStore,
  staticWebPort?: number | null,
  ptyRegistry?: PtyRegistry,
  agentEnvFile?: string,
) {
  return buildDaemonApp(
    cfg,
    composeOpenCodeHarnessService(requireOpenCodeConfig(cfg), lifecycle),
    bootTime,
    bootState,
    projectEnv,
    staticWebPort,
    ptyRegistry,
    agentEnvFile,
  )
}

/** The sandbox token the daemon HTTP tests sign user contexts with. */
export const TEST_SANDBOX_TOKEN = 'test-kortix-token-32-chars-1234567890'

/** A complete OpenCode daemon config for tests: no clone, fixed ports. */
export function testOpenCodeConfig(over: Partial<OpenCodeConfig> = {}): OpenCodeConfig {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: DEFAULT_TEST_WORKSPACE,
    projectTarget: DEFAULT_TEST_WORKSPACE,
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    gitDeltaBundleBase64: undefined,
    gitDeltaParentSha: undefined,
    gitDeltaParentCommitBase64: undefined,
    sandboxToken: TEST_SANDBOX_TOKEN,
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

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** An `X-Kortix-User-Context` value signed the way the API signs it. */
export function signTestUserContext(
  payload: { userId: string; sandboxId: string; sandboxRole: string; scopes?: string[]; ttl?: number },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const body = {
    userId: payload.userId,
    sandboxId: payload.sandboxId,
    sandboxRole: payload.sandboxRole,
    scopes: payload.scopes ?? [],
    iat: now,
    exp: now + (payload.ttl ?? 60),
  }
  const payloadB64 = base64url(Buffer.from(JSON.stringify(body), 'utf8'))
  const sig = base64url(createHmac('sha256', secret).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

/**
 * Two distinct free ports for the OpenCode primary/standby pair. Both stay
 * bound until both are chosen: two sequential port-0 binds returned the same
 * port 10 times in 50,000 on Linux, and a pair with one port makes every
 * verified reload refuse as "port pair is desynced". They are reserved on
 * 127.0.0.1, where the child binds: on macOS a wildcard port-0 bind can return
 * a port another process holds on 127.0.0.1 (267 in 20,000 with 300 such
 * listeners), and the child then exits with EADDRINUSE.
 */
export function reserveOpenCodePortPair(): [primary: number, standby: number] {
  const servers = [0, 1].map(() =>
    Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('reserved') }),
  )
  const [primary, standby] = servers.map((server) => server.port as number)
  for (const server of servers) server.stop(true)
  return [primary!, standby!]
}
