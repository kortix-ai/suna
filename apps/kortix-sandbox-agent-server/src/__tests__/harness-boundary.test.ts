import { describe, expect, test } from 'bun:test'
import { loadConfig, resolveHarness, type HarnessService } from '@/harness/harness'
import { buildDaemonApp } from '@/app/server'
import { createRuntimeProxyRouter } from '@/routes/proxy/runtime-proxy'
import type { HarnessQueryService } from '@/harness/contract/queries'

// Which imports are allowed between host, harness and adapters is the lint's job
// (eslint.config.mjs, run by architecture-boundaries.test.ts). This file owns the
// runtime half: selection, and controllers that keep an adapter's native features.
describe('harness ownership boundary', () => {
  test('KORTIX_HARNESS selects the adapter (default opencode); the selected adapter loads its own environment', () => {
    expect(resolveHarness().id).toBe('opencode')
    expect(resolveHarness(loadConfig())).toBe(resolveHarness())
    const pi = loadConfig({ KORTIX_HARNESS: 'pi', KORTIX_PROJECT_AUTO_CLONE: '0' })
    expect(pi.harness).toBe('pi')
    expect(resolveHarness(pi).id).toBe('pi')
    expect('piStateDir' in pi).toBe(true)
    expect('opencodeInternalPort' in pi).toBe(false)
    const opencode = loadConfig({ KORTIX_HARNESS: ' OpenCode ', KORTIX_PROJECT_AUTO_CLONE: '0' })
    expect(opencode.harness).toBe('opencode')
    expect('opencodeInternalPort' in opencode).toBe(true)
    expect(() => loadConfig({ KORTIX_HARNESS: 'codex' })).toThrow('Unsupported harness: codex')
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
      turns: { prompt: unexpected, steer: unexpected, abort: unexpected, readMessage: unexpected, removeMessage: unexpected, retractMessage: unexpected, agents: unexpected },
      background: { start: unexpected },
      assets: {
        harness: 'test', componentNames: [], resolveConfigDir: async () => '/tmp', injectSkills: async () => {},
        reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
      },
    }
    const app = buildDaemonApp(cfg, service, 0)
    const response = await app.request('/kortix/health')
    expect(response.status).toBe(200)
    // The route composes the host facts, the closed harness block (adapter
    // facts ride in `details`) and one readiness verdict (E19).
    expect(await response.json()).toMatchObject({
      daemon: 'ok',
      capabilities: ['file.import', 'file.append', 'runtime.turns.v1', 'runtime.retract.v1', 'session.subagents'],
      status: 'ok',
      runtimeReady: true,
      boot_error: null,
      workload: 'session',
      harness: { id: 'test-only-adapter', version: '1.0.0', ready: true, details: { exclusiveFeature: 'preserved' } },
      // The pre-W3 flat names, composed from the block for an older API.
      opencode: 'ok',
      opencode_session_id: 'ses_root',
      opencode_session_required: true,
    })
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
