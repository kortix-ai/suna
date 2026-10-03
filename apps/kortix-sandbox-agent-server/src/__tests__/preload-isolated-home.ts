// Test preload: isolate HOME. On a developer machine `$HOME/.local/bin/kortix`
// is the real Kortix CLI; a runtime-assets test once overwrote it with its
// fixture bytes through the writable-PATH fallback (2026-09-28).
//
// Also scrub the platform env a Kortix worker sandbox injects into the agent
// shell (apps/sandbox/entrypoint.sh + /dev/shm/kortix/agent-env.sh): a spawned
// daemon would otherwise run supervised against the live session's identity
// instead of the test's fixture. The suite must be hermetic — identical on a
// laptop and inside a worker sandbox. Tests that exercise one of these states
// set the var themselves.
const INJECTED_KEYS = [
  'KORTIX_SESSION_ID',
  'KORTIX_SUPERVISED',
  'KORTIX_API_URL',
  'KORTIX_TOKEN',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_COMPILED_RUNTIME_FORMAT',
  'KORTIX_COMPILED_RUNTIME_SOURCE_SHA',
  'KORTIX_DEFAULT_BRANCH',
  'KORTIX_BASE_REF',
  'KORTIX_BASE_SHA',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
]

for (const key of INJECTED_KEYS) delete process.env[key]
process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))
