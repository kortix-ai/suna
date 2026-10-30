import { describe, expect, test } from 'bun:test'
import { harnessProtectedPathSegments, isHarnessInternalVariable, loadConfig, resolveHarness, type HarnessService } from '@/harness/harness'
import { buildDaemonApp } from '@/app/server'
import { createRuntimeProxyRouter } from '@/routes/proxy/runtime-proxy'
import type { HarnessQueryService } from '@/harness/contract/queries'

// Which imports are allowed between host, harness and adapters is the lint's job
// (eslint.config.mjs, run by architecture-boundaries.test.ts). This file owns the
// runtime half: selection, and controllers that keep an adapter's native features.
describe('harness ownership boundary', () => {
  test('every box boots pi, a box OpenCode booted before the sunset too; an unknown id fails the boot', () => {
    for (const harness of ['pi', ' OpenCode ', '']) {
      const cfg = loadConfig({ KORTIX_HARNESS: harness, KORTIX_PROJECT_AUTO_CLONE: '0' })
      expect(cfg.harness).toBe('pi')
      expect(resolveHarness(cfg).id).toBe('pi')
      expect('piStateDir' in cfg).toBe(true)
    }
    expect(resolveHarness().id).toBe('pi')
    expect(() => loadConfig({ KORTIX_HARNESS: 'codex' })).toThrow('Unsupported harness: codex')
  })

  test('a box OpenCode booted asks for the session-log restore; a pi box keeps what apps/api set', () => {
    for (const harness of ['opencode', ' OpenCode ', '', undefined]) {
      const env: NodeJS.ProcessEnv = { KORTIX_HARNESS: harness, KORTIX_PROJECT_AUTO_CLONE: '0' }
      loadConfig(env)
      expect(env.KORTIX_SESSION_LOG_RESTORE).toBe('1')
    }
    const pi: NodeJS.ProcessEnv = { KORTIX_HARNESS: 'pi', KORTIX_PROJECT_AUTO_CLONE: '0' }
    loadConfig(pi)
    expect(pi.KORTIX_SESSION_LOG_RESTORE).toBeUndefined()
  })

  test("a box OpenCode booted keeps OpenCode's data directory and variables away from the agent", () => {
    expect(harnessProtectedPathSegments()).toContain('/.local/share/opencode/')
    expect(isHarnessInternalVariable('OPENCODE_SERVER_PASSWORD')).toBe(true)
    expect(isHarnessInternalVariable('KORTIX_PI_PACKAGES')).toBe(true)
    expect(isHarnessInternalVariable('MY_PROJECT_SECRET')).toBe(false)
  })

  test('host controllers call a different resolved service and retain its extra fields and native features', async () => {
    const cfg = loadConfig({ KORTIX_PROJECT_AUTO_CLONE: '0' })
    const unexpected = (): never => { throw new Error('unused operation must not run') }
    const queries: HarnessQueryService = {
      readState: unexpected, readMessages: unexpected,
      events: { epoch: 'test', headSeq: 0, firstSeq: 0, subscribe: unexpected },
      attachments: { read: unexpected },
    }
    const service: HarnessService = {
      id: 'test-only-adapter',
      environment: { home: '/tmp' },
      lifecycle: { start: async () => {}, stop: async () => {}, restart: async () => {}, getState: () => 'down' },
      proxy: {
        blockedPorts: () => [4311, 4312],
        readiness: async () => ({ ready: true }),
        forward: async (input) => ({
          status: 201, statusText: 'Created',
          headers: new Headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ nativeFeature: input.path, input: await new Response(input.body).text() }),
        }),
      },
      control: {
        bind: () => ({
          applyEnvironment: unexpected, refresh: unexpected, abort: unexpected,
          armAbortAfterTool: unexpected, disarmAbortAfterTool: unexpected,
        }),
      },
      diagnostics: {
        capabilities: async () => ['session.subagents'],
        health: async () => ({
          harness: {
            id: 'test-only-adapter', version: '1.0.0', state: 'ok', ready: true, error: null,
            session: { id: 'ses_root', required: true }, turn: null, details: { exclusiveFeature: 'preserved' },
          },
        }),
        report: unexpected, logSources: () => [], readLog: unexpected,
      },
      queries: { bind: () => queries },
      turns: { prompt: unexpected, steer: unexpected, abort: unexpected, readMessage: unexpected, removeMessage: unexpected, retractMessage: unexpected, agents: unexpected, replyPermission: unexpected, replyQuestion: unexpected, rejectQuestion: unexpected, compact: unexpected, command: unexpected, setGrants: unexpected, commands: unexpected, pending: unexpected, readLog: unexpected, readLogMessage: unexpected, readBlob: unexpected, workflows: unexpected, controlWorkflow: unexpected },
      background: { start: unexpected },
      assets: {
        harness: 'test', componentNames: [],          reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
      },
    }
    const app = buildDaemonApp(cfg, service, 0)
    const response = await app.request('/kortix/health')
    expect(response.status).toBe(200)
    // The route composes the host facts, the closed harness block (adapter
    // facts ride in `details`) and one readiness verdict (E19).
    const body = await response.json()
    expect(body).toMatchObject({
      daemon: 'ok',
      capabilities: ['file.import', 'file.append', 'agent-config.env-gz.v1', 'runtime.turns.v1', 'runtime.retract.v1', 'runtime.actions.v1', 'runtime.log.v1', 'session.subagents'],
      status: 'ok',
      runtimeReady: true,
      boot_error: null,
      harness: { id: 'test-only-adapter', version: '1.0.0', ready: true, details: { exclusiveFeature: 'preserved' } },
    })
    // Kortix names only: no pre-W3 `opencode*` field, at the top or in `runtime.running`.
    expect(JSON.stringify(body)).not.toMatch(/"opencode/)
    expect((await app.request('/session/native-command')).status).toBe(503)

    // The transport controller preserves features that are not common methods.
    // The host auth gate above rejects unauthenticated requests before this call.
    const transport = createRuntimeProxyRouter({ cfg, bootState: { repoMaterializationError: null, timeline: [] } }, service.proxy)
    const native = await transport.request('/exclusive-feature', { method: 'POST', body: 'native input' })
    expect(native.status).toBe(201)
    expect(await native.json()).toEqual({ nativeFeature: '/exclusive-feature', input: 'native input' })

    // A runtime that cannot take a request answers one machine code beside the adapter's own details.
    const booting = createRuntimeProxyRouter(
      { cfg, bootState: { repoMaterializationError: null, timeline: [] } },
      { ...service.proxy, readiness: async () => ({ ready: false, phase: 'boot', details: { error: 'adapter wording' } }) },
    )
    const refused = await booting.request('/exclusive-feature')
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ code: 'runtime_not_ready', error: 'adapter wording', phase: 'boot' })
  })
})
