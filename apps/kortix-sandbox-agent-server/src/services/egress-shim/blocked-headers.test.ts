/**
 * The shim and the broker share one BLOCKED_REQUEST_HEADERS list
 * (`@kortix/api-contract/secret-relay`). A hand copy drifted once:
 * `accept-encoding` was added to the broker's list while the shim still SENT
 * it, so every relay 400'd and every deployed daemon broke (2026-08-19).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BLOCKED_REQUEST_HEADERS } from '@kortix/api-contract/secret-relay'

describe('the shared blocked-header list', () => {
  // `accept-encoding` must pass, because the shim forces
  // `accept-encoding: identity` on every relay and the broker drops+forces it
  // server-side. `authorization` and `cookie` must pass, because they are the
  // substitution surfaces (`Authorization: Bearer <handle>`, `Cookie: …=<handle>`).
  test.each(['accept-encoding', 'authorization', 'cookie'])('does not block %s', (header) => {
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
  // `bun build --compile` must pull THESE modules and not `index.ts`, not zod,
  // not anything node-only. A stray import here would drag the whole contract
  // package into the guest binary. CI does not rebuild the daemon when only
  // `packages/api-contract/**` changes, so this is the guard for that edit.
  test.each(['secret-relay.ts', 'egress-shim-rules.ts', 'fallback-models.ts', 'sandbox-layout.ts'])(
    'the shared module %s is dependency-free',
    (file) => {
      const source = readFileSync(join(import.meta.dir, '../../../../../packages/api-contract/src', file), 'utf8')
      const imports = [...source.matchAll(/^\s*import .*/gm)].map((m) => m[0])
      expect(imports).toEqual([])
    },
  )

  // The daemon builds STANDALONE: `apps/sandbox/Dockerfile` copies only this
  // app's package.json + bun.lock and reaches the contract through the tsconfig
  // `paths` mapping, so the image must mirror the repo layout. No CI job builds
  // the image before merge, so this source check is the only guard.
  test('the sandbox Dockerfile copies the package that mapping points at', () => {
    const appDir = join(import.meta.dir, '../../..')
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
