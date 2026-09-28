/**
 * Tripwire: every route mounted under /kortix/* must check its own credential.
 *
 * app/server.ts exempts the /kortix/* namespace from the daemon's global auth gate
 * (`app.use('*', ...)` only runs for a path NOT starting with `/kortix/`) —
 * see the comment on that gate — precisely so each route in the namespace
 * authenticates itself. A route added to the namespace without wiring one of
 * the shared checks is an open door the moment a daemon runs anywhere the
 * API's sandbox proxy is not in front of it. This is what /kortix/part
 * missed (see routes/kortix/part.ts and part-route-auth.test.ts).
 *
 * `health` is the sole declared exception: GET /kortix/health must answer
 * before a caller has anything to authenticate with.
 *
 * The route-file list below is DERIVED from app/server.ts and routes/kortix/harness-control.ts,
 * the two places a route is wired into the namespace, not hand-maintained —
 * a newly added route is picked up automatically instead of silently never
 * being checked.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '..')
const ROUTES_DIR = resolve(sourceRoot, 'routes')
const PROXY_FILE = resolve(sourceRoot, 'app', 'server.ts')
const HARNESS_CONTROL_FILE = resolve(ROUTES_DIR, 'kortix', 'harness-control.ts')

/** Route labels that are unauthenticated by design. */
const EXEMPT = new Set(['health'])

/** True if `source` calls a check that rejects a request lacking a valid credential. */
function hasCredentialCheck(source: string): boolean {
  return (
    /authorizeControl\s*\(/.test(source) ||
    /verifyKortixUserContext\s*\(/.test(source) ||
    /[=!]==\s*cfg\.sandboxToken\b/.test(source)
  )
}

/** Resolve `import { <name> } from '<spec>'` inside `hostSource` to an absolute .ts path. */
function resolveImport(hostSource: string, hostFile: string, name: string): string | null {
  const re = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`)
  const spec = re.exec(hostSource)?.[1]
  if (!spec) return null
  // `@/` is src/ (tsconfig.json); anything else is relative to the host file.
  return spec.startsWith('@/') ? resolve(sourceRoot, `${spec.slice(2)}.ts`) : resolve(dirname(hostFile), `${spec}.ts`)
}

/**
 * The route files reachable under /kortix/* — every router mounted on
 * `kortixRouter` in app/server.ts (directly, or indirectly through
 * createHarnessControlRouter's own `mount(...)` calls in harness-control.ts).
 */
function namespaceRouteFiles(): Map<string, string> {
  const files = new Map<string, string>() // label -> absolute .ts path

  const proxySource = readFileSync(PROXY_FILE, 'utf8')
  for (const m of proxySource.matchAll(/kortixRouter\.route\('([^']+)',\s*(\w+)\)/g)) {
    const label = m[1]!.replace(/^\//, '').replace(/\/$/, '')
    const varName = m[2]!
    const creator = new RegExp(`const\\s+${varName}\\s*=\\s*(create\\w+Router)\\(`).exec(proxySource)?.[1]
    if (!creator) continue
    const file = resolveImport(proxySource, PROXY_FILE, creator)
    if (file) files.set(label || 'root', file)
  }

  const hcSource = readFileSync(HARNESS_CONTROL_FILE, 'utf8')
  for (const m of hcSource.matchAll(/mount\('([^']+)',\s*(create\w+Router)\(/g)) {
    const label = m[1]!.replace(/^\//, '')
    const file = resolveImport(hcSource, HARNESS_CONTROL_FILE, m[2]!)
    if (file) files.set(label, file)
  }

  return files
}

describe('kortix namespace auth boundary', () => {
  test('every /kortix/* route file checks a credential, except health', () => {
    const files = namespaceRouteFiles()
    // A floor so the derivation itself can't silently degrade to "found
    // nothing" and vacuously pass: if this trips, the extraction regexes no
    // longer match app/server.ts/harness-control.ts's current shape and need
    // updating, not the floor lowered.
    expect(files.size).toBeGreaterThanOrEqual(10)

    const offenders: string[] = []
    for (const [label, file] of files) {
      if (EXEMPT.has(label)) continue
      const source = readFileSync(file, 'utf8')
      if (!hasCredentialCheck(source)) offenders.push(label)
    }
    expect(offenders).toEqual([])
  })

  test('negative probe: the detector actually flags a route with no credential check', () => {
    // Proves hasCredentialCheck can return false — a detector with a bug that
    // always returns true would pass the test above without checking anything.
    const openRoute = `
      export function createOpenRouter(cfg: Config): Hono {
        const router = new Hono()
        router.get('/', (c) => c.json({ ok: true }))
        return router
      }
    `
    expect(hasCredentialCheck(openRoute)).toBe(false)
    expect(hasCredentialCheck(`${openRoute}\nauthorizeControl(c, cfg, 'x')`)).toBe(true)
    expect(hasCredentialCheck(`${openRoute}\nverifyKortixUserContext(h, cfg.sandboxToken)`)).toBe(true)
    expect(hasCredentialCheck(`${openRoute}\nbearerToken(h) === cfg.sandboxToken`)).toBe(true)
  })

  test('the derivation finds the known namespace routes, including /kortix/part', () => {
    const files = namespaceRouteFiles()
    const labels = new Set(files.keys())
    for (const expected of ['health', 'part', 'logs', 'diag', 'abort', 'refresh']) {
      expect(labels.has(expected)).toBe(true)
    }
    expect(files.get('part')).toBe(resolve(ROUTES_DIR, 'kortix', 'part.ts'))
  })
})
