/**
 * The shim's BLOCKED_REQUEST_HEADERS is a hand-copied mirror of the broker's
 * list (apps/api/src/secrets/http-broker.ts) — the daemon must not import
 * apps/api. A copy can drift, and one already did: `accept-encoding` was added
 * to the broker's list while the shim still SENT it, so every relay 400'd and
 * every deployed daemon broke (2026-08-19, spec §4 "old daemons keep working").
 *
 * This file reads the broker's real list off disk and asserts the two agree —
 * so a future edit to either side that breaks the contract fails here instead
 * of in a guest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BLOCKED_REQUEST_HEADERS } from './blocked-headers'

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
    expect(broker.size).toBeGreaterThan(5)
    expect([...BLOCKED_REQUEST_HEADERS].sort()).toEqual([...broker].sort())
  })

  // The two lists could agree and still both be wrong. `accept-encoding` must
  // pass, because the shim forces `accept-encoding: identity` on every relay
  // and the broker drops+forces it server-side. `authorization` and `cookie`
  // must pass, because they are the substitution surfaces
  // (`Authorization: Bearer <handle>`, `Cookie: …=<handle>`).
  test.each(['accept-encoding', 'authorization', 'cookie'])('the lists do not block %s', (header) => {
    expect(BLOCKED_REQUEST_HEADERS.has(header)).toBe(false)
  })
})

/**
 * The streaming relay contract is NOT copied: both sides import
 * `@kortix/api-contract/secret-relay`, and the streaming rows in
 * `shim.test.ts` decode the wire with that codec. What this file still owns is
 * the build shape that makes the import possible inside the guest binary.
 */
describe('the shared relay contract fits in the sandbox binary', () => {
  test('the shared module is dependency-free', () => {
    // `bun build --compile` must pull THIS module and not `index.ts`, not zod,
    // not anything node-only. A stray import here would drag the whole contract
    // package into the guest binary. CI does not rebuild the daemon when only
    // `packages/api-contract/**` changes, so this is the guard for that edit.
    const codec = readFileSync(
      join(import.meta.dir, '../../../../packages/api-contract/src/secret-relay.ts'),
      'utf8',
    )
    const imports = [...codec.matchAll(/^\s*import .*/gm)].map((m) => m[0])
    expect(imports).toEqual([])
  })

  // The daemon builds STANDALONE: `apps/sandbox/Dockerfile` copies only this
  // app's package.json + bun.lock and reaches the contract through the tsconfig
  // `paths` mapping, so the image must mirror the repo layout. No CI job builds
  // the image before merge, so this source check is the only guard.
  test('the sandbox Dockerfile copies the package that mapping points at', () => {
    const appDir = join(import.meta.dir, '../..')
    const dockerfile = readFileSync(join(appDir, '../sandbox/Dockerfile'), 'utf8')
    const builder = dockerfile.slice(
      dockerfile.indexOf('AS builder'),
      dockerfile.indexOf('AS cli-builder'),
    )
    expect(builder).toContain('COPY packages/api-contract /repo/packages/api-contract')
    expect(builder).toContain('WORKDIR /repo/apps/kortix-sandbox-agent-server')
    // …and the runtime stage must copy the binary from where it now lands.
    // Matched on source+destination rather than the literal line: the COPY also
    // carries `--chmod` (setting the mode in a later RUN duplicates a 290 MB
    // layer). The assertion is about WHERE the binary comes from.
    expect(dockerfile).toMatch(
      /COPY --from=builder [^\n]*\/repo\/apps\/kortix-sandbox-agent-server\/dist\/kortix-agent\s+\/usr\/local\/bin\/kortix-agent/,
    )
  })
})
