/**
 * P6.5. Each session-log adapter declares, in `*_CAPABILITIES`, the harness versions
 * (`harness_versions`, a semver range) and the schema minors (`schema_minors`) its oracle
 * suites passed against. A bump of the pinned harness, or of `SESSION_LOG_MINOR`, fails here
 * until the oracle suites pass on the new version and the declaration names it
 * (src/harness/README.md, "Bumping a harness").
 */
import { describe, expect, test } from 'bun:test'
import { SESSION_LOG_MINOR, type AdapterCapabilities } from '@kortix/api-contract/session-log'
import { OPENCODE_CAPABILITIES } from '@/harness/open-code/session-log'
import { PI_CAPABILITIES } from '@/harness/pi/session-log'
import { PI_HARNESS_VERSION } from '@/harness/pi/version'
import versions from '../../../../packages/shared/src/runtime-versions.json'
import pkg from '../../package.json'

/** Every session-log suite: both adapters' exports and restores against the real harness, the boot, the journal. */
const ORACLE = '`bun run test session-log` in apps/kortix-sandbox-agent-server'
type Pin = [pin: string, version: string, caps: AdapterCapabilities]
/** What the box runs: pi is bundled from these exact deps; the image installs `opencode` from runtime-versions.json. */
const PINS: Pin[] = [
  ...Object.entries(pkg.dependencies)
    .filter(([name]) => name.startsWith('@earendil-works/pi-'))
    .map(([name, version]): Pin => [name, version, PI_CAPABILITIES]),
  ['PI_HARNESS_VERSION (src/harness/pi/version.ts)', PI_HARNESS_VERSION.split('@').pop()!, PI_CAPABILITIES],
  ['opencode (packages/shared/src/runtime-versions.json)', versions.opencode, OPENCODE_CAPABILITIES],
]

describe('each adapter declares what its oracle suites passed against', () => {
  test.each(PINS)('%s %s', (pin, version, caps) => {
    expect(
      Bun.semver.satisfies(version, caps.harness_versions),
      `${pin} pins ${caps.harness} ${version}; the ${caps.harness} adapter is tested against ${caps.harness_versions}. ` +
        `Run the oracle suites on ${version} (${ORACLE}), ` +
        `then add ${version} to ${caps.harness}'s harness_versions (README "Bumping a harness").`,
    ).toBe(true)
  })

  test.each([PI_CAPABILITIES, OPENCODE_CAPABILITIES].map((caps) => [caps.harness, caps] as const))('%s: the contract minor', (_, caps) => {
    expect(
      caps.schema_minors.includes(SESSION_LOG_MINOR),
      `@kortix/api-contract exports SESSION_LOG_MINOR ${SESSION_LOG_MINOR}; the ${caps.harness} adapter declares schema_minors ` +
        `[${caps.schema_minors.join(', ')}]. Run the oracle suites (${ORACLE}), then add ${SESSION_LOG_MINOR} (README "Bumping a harness").`,
    ).toBe(true)
  })
})
