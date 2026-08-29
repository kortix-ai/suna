/**
 * The duplication tripwire for the SQLite reader's version gate.
 *
 * `SQLITE_READER_SUPPORTED_MINORS` in `opencode-db.ts` is a COPY of a fact that
 * lives in `packages/shared/src/runtime-versions.json`. It has to be a copy:
 * this daemon ships inside the sandbox image and cannot import from the
 * monorepo — the same constraint `proxy.ts` documents for
 * `isBlockingTurnRequest`, and the same pattern `kortix-user-context.ts` uses.
 *
 * A copy without a tripwire rots. When the OpenCode pin moves to a minor line
 * this reader has not been verified against, this test fails HERE — in a test —
 * instead of on a box, where the failure mode is a transcript read served from
 * a schema nobody checked. Fixing it is deliberate work: verify the shape on a
 * box of the new version, then add the minor line.
 *
 * The test file may import from the monorepo; only the shipped `src/*.ts` may
 * not.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SQLITE_READER_SUPPORTED_MINORS, isSupportedOpencodeVersion } from '../opencode-db'

const RUNTIME_VERSIONS = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'runtime-versions.json',
)

describe('opencode version pin', () => {
  test('the shipped pin is a version this reader is verified against', () => {
    const manifest = JSON.parse(readFileSync(RUNTIME_VERSIONS, 'utf8')) as { opencode?: string }
    expect(typeof manifest.opencode).toBe('string')
    expect(
      isSupportedOpencodeVersion(manifest.opencode!),
      `runtime-versions.json pins opencode ${manifest.opencode}, which is outside ` +
        `SQLITE_READER_SUPPORTED_MINORS (${SQLITE_READER_SUPPORTED_MINORS.join(', ')}). ` +
        'Verify opencode.db\'s session/message/part/event schema on a box of that ' +
        'version, then add the minor line — do not widen the gate blind.',
    ).toBe(true)
  })

  test('the gate is a whitelist, not a floor', () => {
    // A floor would let an unverified future schema through. Assert the
    // property, so a refactor to `>=` fails here.
    const [major, minor] = SQLITE_READER_SUPPORTED_MINORS[0]!.split('.').map(Number)
    expect(isSupportedOpencodeVersion(`${major}.${minor! + 1}.0`)).toBe(false)
  })
})
