import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { Hono } from 'hono'
import { loadConfig } from '../config'
import { resolveHarness, type HarnessService } from '../harness/harness'
import { buildDaemonApp } from '../proxy'

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

  test('the host mounts adapter-specific features without knowing their protocol', async () => {
    const cfg = loadConfig({ KORTIX_PROJECT_AUTO_CLONE: '0' })
    const service: HarnessService = {
      id: 'test-only-adapter',
      environment: { home: '/tmp' },
      lifecycle: { start: async () => {}, stop: async () => {}, restart: async () => {}, getState: () => 'down' },
      http: {
        blockedPorts: () => [4311, 4312],
        mountControlRoutes(router) {
          const features = new Hono()
          features.get('/exclusive-feature', (c) => c.json({ feature: 'preserved' }))
          router.route('/test-adapter', features)
        },
        mountFallback() {},
      },
      background: { start: () => { throw new Error('building the app must not start a runtime') } },
      assets: {
        componentNames: [],
        resolveConfigDir: async () => '/tmp',
        injectSkills: async () => {},
        reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
      },
    }
    const app = buildDaemonApp(cfg, service, 0)
    const response = await app.request('/kortix/test-adapter/exclusive-feature')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ feature: 'preserved' })
    expect((await app.request('/session/native-command')).status).toBe(503)
  })
})
