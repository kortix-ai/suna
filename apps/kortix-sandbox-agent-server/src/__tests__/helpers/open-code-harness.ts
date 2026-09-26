import { createHmac } from 'node:crypto'

import type { Config } from '../../config'
import type { OpenCodeConfig } from '../../harness/open-code/config'
import type { ProjectEnvStore } from '../../project-env'
import type { OpenCodeBootState } from '../../harness/open-code/boot-state'
import { requireOpenCodeConfig } from '../../harness/open-code/config'
import type { Opencode } from '../../harness/open-code/lifecycle'
import { composeOpenCodeHarnessService } from '../../harness/open-code/service'
import { buildDaemonApp } from '../../proxy'
import type { PtyRegistry } from '../../routes/pty'

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
    workspace: '/workspace',
    projectTarget: '/workspace',
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
