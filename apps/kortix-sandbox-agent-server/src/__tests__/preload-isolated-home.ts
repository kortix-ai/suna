// Test preload: isolate HOME and drop the host box's own Kortix identity.
// On a developer machine `$HOME/.local/bin/kortix` is the real Kortix CLI; a
// runtime-assets test once overwrote it with its fixture bytes through the
// writable-PATH fallback (2026-09-28). A Kortix box also exports the agent
// session's identity into every shell (KORTIX_MODEL, KORTIX_HARNESS,
// KORTIX_COMPILED_AGENT_CONFIG, …), and the suites are written against a
// CI-shaped env that lacks it: the box's model registered itself into a rig
// that asserts the catalog lacks it, the box's compiled agent layered into a
// native-mode rig, the box's harness selected the wrong adapter (2026-10-03).
// The packages lane scrubs the same variables for every workspace suite
// (tests/bin/package-quality.ts hermeticWorkspaceEnv); this preload gives a
// plain `bun test` in this package the same shape, with no manual scrub.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Variables that are runner controls, not session identity, and must survive.
 * KORTIX_ATTACHMENT_OFFLOAD is the lane's "no background maintenance in
 * suites" toggle (tests/bin/package-quality.ts runWorkspaceTests); dropping it
 * would turn the maintenance on exactly where the lane turns it off.
 */
const KEEP = new Set([
  'KORTIX_API_TEST_WORKERS',
  'KORTIX_ATTACHMENT_OFFLOAD',
  'KORTIX_MIN_TEST_FILES',
  'KORTIX_PACKAGE_SKIP_SDK_TESTS',
  'KORTIX_TEST_TIMEOUT_MS',
])

for (const name of Object.keys(process.env)) {
  if (name.startsWith('KORTIX_') && !KEEP.has(name)) delete process.env[name]
}

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))
