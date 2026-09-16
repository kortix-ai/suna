import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { loadConfig } from '../config'
import { resolveHarness, type HarnessService } from '../harness/harness'
import { buildDaemonApp } from '../proxy'
import { createRuntimeProxyRouter } from '../routes/runtime-proxy'
import type { HarnessQueryService } from '../harness/queries'

const sourceRoot = resolve(import.meta.dir, '..')
const nativeRoot = resolve(sourceRoot, 'harness/open-code')

describe('harness ownership boundary', () => {
  test('only the resolver can import a concrete adapter from host production code', async () => {
    const leaks: string[] = []
    for await (const name of new Bun.Glob('**/*.ts').scan(sourceRoot)) {
      if (name.includes('__tests__/') || name.endsWith('.test.ts') || name.startsWith('harness/open-code/')) continue
      if (name === 'harness/harness.ts') continue
      const file = resolve(sourceRoot, name)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const inspect = (node: ts.Node) => {
        let specifier: ts.Expression | undefined
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
        if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
          const target = resolve(dirname(file), specifier.text)
          if (target === nativeRoot || target.startsWith(nativeRoot + '/')) leaks.push(`${name} -> ${relative(sourceRoot, target)}`)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }
    expect(leaks).toEqual([])
    expect(existsSync(resolve(sourceRoot, 'opencode-events.ts'))).toBe(false)
    expect(existsSync(resolve(sourceRoot, 'opencode.ts'))).toBe(false)
  })

  test('resolution preserves the existing default and rejects an unknown selection', () => {
    expect(resolveHarness().id).toBe('opencode')
    expect(resolveHarness(loadConfig())).toBe(resolveHarness())
    expect(() => resolveHarness(undefined, 'missing-adapter')).toThrow('Unsupported harness: missing-adapter')
  })

  test('harness modules cannot import the HTTP framework or host controllers', async () => {
    const leaks: string[] = []
    for await (const name of new Bun.Glob('harness/**/*.ts').scan(sourceRoot)) {
      const file = resolve(sourceRoot, name)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const inspect = (node: ts.Node) => {
        let specifier: ts.Expression | undefined
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const target = resolve(dirname(file), specifier.text)
          if (specifier.text === 'hono' || specifier.text.startsWith('hono/') ||
              target.startsWith(resolve(sourceRoot, 'routes') + '/')) leaks.push(`${name} -> ${specifier.text}`)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }
    expect(leaks).toEqual([])
    for (const name of ['health', 'refresh', 'abort', 'env', 'logs', 'diag', 'part', 'opencode-runtime']) {
      expect(existsSync(resolve(nativeRoot, `routes/${name}.ts`))).toBe(false)
    }
    expect(existsSync(resolve(nativeRoot, 'http.ts'))).toBe(false)
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
      control: { bind: () => ({ applyEnvironment: unexpected, refresh: unexpected, abort: unexpected }) },
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
    expect(await response.json()).toEqual({ daemon: 'ok', status: 'ok', runtimeReady: true, uptime_s: 1, exclusiveFeature: 'preserved' })
    expect((await app.request('/session/native-command')).status).toBe(503)

    // The transport controller preserves features that are not common methods.
    // The host auth gate above rejects unauthenticated requests before this call.
    const transport = createRuntimeProxyRouter({ cfg, bootState: { repoMaterializationError: null, timeline: [] } }, service.proxy)
    const native = await transport.request('/exclusive-feature', { method: 'POST', body: 'native input' })
    expect(native.status).toBe(201)
    expect(await native.json()).toEqual({ nativeFeature: '/exclusive-feature', input: 'native input' })
  })
})
