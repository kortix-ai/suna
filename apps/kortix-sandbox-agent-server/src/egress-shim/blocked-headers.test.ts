/**
 * The shim's BLOCKED_REQUEST_HEADERS is a hand-copied mirror of the broker's
 * list (apps/api/src/secrets/http-broker.ts) — the daemon must not import
 * apps/api. A copy can drift, and one already did: `accept-encoding` was added
 * to the broker's list while the shim still SENT it, so every relay 400'd and
 * every deployed daemon broke (2026-08-19, spec §4 "old daemons keep working").
 *
 * This test is the tripwire that comment always claimed existed and never did.
 * It reads the broker's real list off disk and asserts the two agree — so a
 * future edit to either side that breaks the contract fails here instead of in
 * a guest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BLOCKED_REQUEST_HEADERS } from './shim'

function brokerBlockedHeaders(): Set<string> {
  const src = readFileSync(
    join(import.meta.dir, '../../../api/src/secrets/http-broker.ts'),
    'utf8',
  )
  const block = src.match(/BLOCKED_REQUEST_HEADERS = new Set\(\[([\s\S]*?)\]\)/)
  const body = block?.[1]
  if (!body) throw new Error('could not find BLOCKED_REQUEST_HEADERS in http-broker.ts')
  const names: string[] = []
  for (const m of body.matchAll(/'([^']+)'/g)) if (m[1]) names.push(m[1])
  return new Set(names)
}

describe('shim/broker blocked-header agreement', () => {
  test('the two lists are identical', () => {
    const broker = brokerBlockedHeaders()
    expect([...BLOCKED_REQUEST_HEADERS].sort()).toEqual([...broker].sort())
  })

  // The regression that motivated this file: the broker must NOT block
  // accept-encoding, because the shim (and every deployed daemon) forces
  // `accept-encoding: identity` on every relay. The broker drops+forces it
  // server-side instead.
  test('neither list blocks accept-encoding', () => {
    expect(BLOCKED_REQUEST_HEADERS.has('accept-encoding')).toBe(false)
    expect(brokerBlockedHeaders().has('accept-encoding')).toBe(false)
  })

  // The credential-carrying headers must NOT be blocked: they are the
  // substitution surfaces (`Authorization: Bearer <handle>`, `Cookie: …=<handle>`).
  // Blocking them left the substitution-only default with no working Bearer path.
  test('neither list blocks authorization or cookie', () => {
    for (const header of ['authorization', 'cookie']) {
      expect(BLOCKED_REQUEST_HEADERS.has(header)).toBe(false)
      expect(brokerBlockedHeaders().has(header)).toBe(false)
    }
  })
})

/**
 * The same tripwire, extended over the STREAMING relay's control headers.
 *
 * The list above is a hand copy with a disk-reading test behind it, because a
 * copy already drifted and broke production. A base64/JSON codec is far riskier
 * to duplicate than ten strings, so the relay contract is NOT copied at all:
 * both sides import `@kortix/api-contract/secret-relay`. These tests assert
 * that structural fact rather than comparing two copies — if anybody
 * hand-inlines a header name on either side, this fails.
 */
describe('shim/API relay-contract agreement', () => {
  test('the shim reads the relay header names from the SHARED module', () => {
    const client = readFileSync(join(import.meta.dir, 'relay-client.ts'), 'utf8')
    expect(client).toContain("from '@kortix/api-contract/secret-relay'")
    // No hand-inlined copies of the wire strings anywhere in the client.
    for (const literal of [
      "'x-kortix-relay'",
      "'x-kortix-relay-meta'",
      "'x-kortix-relay-status'",
      "'x-kortix-relay-error'",
      "'x-kortix-relay-probe'",
    ]) {
      expect(client).not.toContain(literal)
    }
  })

  test('the API route reads them from the SAME shared module', () => {
    const route = readFileSync(
      join(import.meta.dir, '../../../api/src/projects/routes/secret-relay.ts'),
      'utf8',
    )
    expect(route).toContain("from '@kortix/api-contract/secret-relay'")
    for (const literal of [
      "'x-kortix-relay-meta'",
      "'x-kortix-relay-status'",
      "'x-kortix-relay-error'",
    ]) {
      expect(route).not.toContain(literal)
    }
  })

  test('the shared module is dependency-free, so it fits in the sandbox binary', () => {
    // `bun build --compile` must pull THIS module and not `index.ts`, not zod,
    // not anything node-only. A stray import here would drag the whole contract
    // package into the guest binary.
    const codec = readFileSync(
      join(import.meta.dir, '../../../../packages/api-contract/src/secret-relay.ts'),
      'utf8',
    )
    const imports = [...codec.matchAll(/^\s*import .*/gm)].map((m) => m[0])
    expect(imports).toEqual([])
  })

  test('the codec constants actually resolve from inside the daemon', async () => {
    const codec = await import('@kortix/api-contract/secret-relay')
    expect(codec.RELAY_META_HEADER).toBe('x-kortix-relay-meta')
    expect(codec.RELAY_STATUS_HEADER).toBe('x-kortix-relay-status')
    expect(codec.RELAY_ERROR_HEADER).toBe('x-kortix-relay-error')
    expect(codec.RELAY_PROBE_HEADER).toBe('x-kortix-relay-probe')
    expect(codec.RELAY_VERSION_HEADER).toBe('x-kortix-relay')
  })
})

/**
 * The daemon builds STANDALONE. That is not an accident and it is not free.
 *
 * `apps/sandbox/Dockerfile` copies ONLY this app's `package.json` + `bun.lock`
 * into the builder stage and runs `bun install --frozen-lockfile`;
 * `.github/workflows/ci.yml` runs the same command with this directory as its
 * working directory. Neither has a workspace root. So a `"workspace:*"`
 * dependency here does not merely go unresolved — it fails the install:
 *
 *   error: Workspace dependency "@kortix/api-contract" not found
 *   Searched in "./*"
 *   error: @kortix/api-contract@workspace:* failed to resolve
 *
 * which reds the `sandbox-agent-build` job AND makes it impossible to build any
 * sandbox image at all, for this change or any unrelated one. It happened. The
 * shared relay contract is reached through a tsconfig `paths` mapping instead,
 * and the Dockerfile mirrors the repo layout so that mapping resolves.
 */
describe('the daemon still builds standalone', () => {
  const appDir = join(import.meta.dir, '../..')

  test('package.json declares NO workspace: dependency', () => {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const workspaceDeps = Object.entries(all).filter(([, range]) => range.startsWith('workspace:'))
    expect(workspaceDeps).toEqual([])
  })

  test('bun.lock lists exactly the dependencies package.json declares', () => {
    // `--frozen-lockfile` fails on ANY divergence, so a package.json edit that
    // forgets the lock is the same outage in a different shape.
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const lock = readFileSync(join(appDir, 'bun.lock'), 'utf8')
    const root = lock.match(/"workspaces":\s*\{\s*"":\s*\{([\s\S]*?)\n {4}\},/)?.[1] ?? ''
    for (const name of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
      expect(root).toContain(`"${name}"`)
    }
  })

  test('the shared contract is reached through a tsconfig path mapping', () => {
    const tsconfig = readFileSync(join(appDir, 'tsconfig.json'), 'utf8')
    expect(tsconfig).toContain('"@kortix/api-contract/*"')
    expect(tsconfig).toContain('../../packages/api-contract/src/*')
  })

  test('the sandbox Dockerfile copies the package that mapping points at', () => {
    const dockerfile = readFileSync(join(appDir, '../sandbox/Dockerfile'), 'utf8')
    const builder = dockerfile.slice(
      dockerfile.indexOf('AS builder'),
      dockerfile.indexOf('AS cli-builder'),
    )
    expect(builder).toContain('COPY packages/api-contract /repo/packages/api-contract')
    expect(builder).toContain('WORKDIR /repo/apps/kortix-sandbox-agent-server')
    // …and the runtime stage must copy the binary from where it now lands.
    expect(dockerfile).toContain(
      'COPY --from=builder /repo/apps/kortix-sandbox-agent-server/dist/kortix-agent',
    )
  })
})
