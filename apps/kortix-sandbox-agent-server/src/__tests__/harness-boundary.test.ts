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
      readState: unexpected, readMessages: unexpected, readVcsDiff: unexpected,
      readCurrentProject: unexpected, readConfiguration: unexpected,
      readSession: unexpected, readTodo: unexpected, pinnedSessionId: unexpected,
      replyPermission: unexpected, replyQuestion: unexpected, rejectQuestion: unexpected,
      stopSession: unexpected, revertSession: unexpected, unrevertSession: unexpected,
      observeTurn: unexpected,
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
        health: async () => ({ daemon: 'ok', status: 'ok', runtimeReady: true, uptime_s: 1, exclusiveFeature: 'preserved' }),
        report: unexpected, logSources: () => [], readLog: unexpected,
      },
      queries: { bind: () => queries },
      background: { start: unexpected },
      assets: {
        componentNames: [], resolveConfigDir: async () => '/tmp', injectSkills: async () => {},
        reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
      },
    }
    const app = buildDaemonApp(cfg, service, 0)
    const response = await app.request('/kortix/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ daemon: 'ok', capabilities: ['file.import', 'file.append'], status: 'ok', runtimeReady: true, uptime_s: 1, exclusiveFeature: 'preserved' })
    expect((await app.request('/session/native-command')).status).toBe(503)

    // The transport controller preserves features that are not common methods.
    // The host auth gate above rejects unauthenticated requests before this call.
    const transport = createRuntimeProxyRouter({ cfg, bootState: { repoMaterializationError: null, timeline: [] } }, service.proxy)
    const native = await transport.request('/exclusive-feature', { method: 'POST', body: 'native input' })
    expect(native.status).toBe(201)
    expect(await native.json()).toEqual({ nativeFeature: '/exclusive-feature', input: 'native input' })
  })
})
