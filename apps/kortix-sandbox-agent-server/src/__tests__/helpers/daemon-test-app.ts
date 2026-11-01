import { createHmac } from 'node:crypto'

import type { Config } from '@/lib/config/config'
import type { HarnessService } from '@/harness/harness'

/** The sandbox token the daemon HTTP tests sign user contexts with. */
export const TEST_SANDBOX_TOKEN = 'test-kortix-token-32-chars-1234567890'

/** A complete host config for daemon tests: no clone, fixed ports. */
export function testConfig(over: Partial<Config> = {}): Config {
  return {
    harness: 'pi',
    servicePort: 8000,
    staticPort: 3211,
    workspace: '/workspace',
    projectTarget: `/tmp/kortix-test-workspace-${process.pid}`,
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_SANDBOX_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
    ...over,
  }
}

const unused = (name: string) => (): never => {
  throw new Error(`${name} is not part of this test`)
}

/**
 * A harness for tests of host routes: every operation throws unless the test
 * supplies it, so a route that reaches the harness unexpectedly fails loudly.
 */
export function fakeHarness(over: Partial<HarnessService> = {}): HarnessService {
  return {
    id: 'test',
    environment: { home: '/tmp' },
    lifecycle: { start: async () => {}, stop: async () => {}, restart: async () => {}, getState: () => 'ok' },
    proxy: {
      blockedPorts: () => [],
      readiness: async () => ({ ready: true }),
      forward: unused('proxy.forward'),
    },
    control: {
      bind: () => ({
        applyEnvironment: unused('control.applyEnvironment'), refresh: unused('control.refresh'), abort: unused('control.abort'),
        armAbortAfterTool: unused('control.armAbortAfterTool'), disarmAbortAfterTool: unused('control.disarmAbortAfterTool'),
      }),
    },
    diagnostics: {
      capabilities: async () => [],
      health: async () => ({
        harness: { id: 'test', version: null, state: 'ok', ready: true, error: null, session: { id: null, required: false }, turn: null, details: {} },
      }),
      report: unused('diagnostics.report'),
      logSources: () => [],
      readLog: unused('diagnostics.readLog'),
    },
    queries: {
      bind: () => ({
        readState: unused('queries.readState'), readMessages: unused('queries.readMessages'),
        events: { epoch: 'test', headSeq: 0, firstSeq: 0, subscribe: unused('queries.events.subscribe') },
        attachments: { read: unused('queries.attachments.read') },
      }),
    },
    turns: {
      prompt: unused('turns.prompt'), steer: unused('turns.steer'), abort: unused('turns.abort'),
      readMessage: unused('turns.readMessage'), removeMessage: unused('turns.removeMessage'),
      retractMessage: unused('turns.retractMessage'), agents: unused('turns.agents'),
      replyPermission: unused('turns.replyPermission'), replyQuestion: unused('turns.replyQuestion'), rejectQuestion: unused('turns.rejectQuestion'), compact: unused('turns.compact'), command: unused('turns.command'), setGrants: unused('turns.setGrants'), commands: unused('turns.commands'), pending: unused('turns.pending'), readLog: unused('turns.readLog'), readLogMessage: unused('turns.readLogMessage'), readBlob: unused('turns.readBlob'), workflows: unused('turns.workflows'), controlWorkflow: unused('turns.controlWorkflow'),
    },
    // `startProxy` starts it; an idle monitor that never ticks.
    background: { start: () => ({ stop: () => {}, latest: () => null, tick: unused('background.tick') }) },
    assets: {
      harness: 'test', componentNames: [],        reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
    },
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
