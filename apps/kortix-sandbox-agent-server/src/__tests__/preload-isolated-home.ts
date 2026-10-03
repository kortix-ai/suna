// Test preload: isolate HOME. On a developer machine `$HOME/.local/bin/kortix`
// is the real Kortix CLI; a runtime-assets test once overwrote it with its
// fixture bytes through the writable-PATH fallback (2026-09-28).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))

// A Kortix sandbox run injects its live session identity into the environment.
// The suites define the adapter, project, model catalog and runtime identity
// they test per case; inherited values change what the code under test
// resolves (harness selection, boot-config model floor, managed-model
// convergence, materialize/refresh targets), so scrub them like HOME above.
for (const key of [
  'KORTIX_HARNESS',
  'KORTIX_SESSION_ID',
  'KORTIX_SESSION_CONTEXT',
  'KORTIX_BOOTSTRAP_RUNTIME_SESSION',
  'KORTIX_PROJECT_ID',
  'KORTIX_OPENCODE_MODEL',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
  'KORTIX_COMPILED_RUNTIME_FORMAT',
  'KORTIX_COMPILED_RUNTIME_SOURCE_SHA',
]) delete process.env[key]
