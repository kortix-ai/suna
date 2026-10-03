// Test preload: isolate HOME and the session env. On a developer machine
// `$HOME/.local/bin/kortix` is the real Kortix CLI; a runtime-assets test once
// overwrote it with its fixture bytes through the writable-PATH fallback
// (2026-09-28).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))

// And isolate the session env. A suite that runs INSIDE a Kortix sandbox (the
// factory workers' own box, any agent's dev box) inherits the session's
// identity: the pi harness flag, a live repo URL, the compiled agent config,
// the session's model. Every test file here asserts CI-shaped defaults — CI
// exports none of these — so a test that passes with them present is green in
// CI and red in the very environment this repo is developed in. Delete the
// session-scoped names up front; a test that needs one sets it explicitly
// (rigEnv in pi-harness.test.ts, ENV_KEYS in opencode-lifecycle.e2e.test.ts).
for (const key of [
  'KORTIX_HARNESS',
  'KORTIX_REPO_URL',
  'KORTIX_API_URL',
  'KORTIX_TOKEN',
  'KORTIX_SESSION_ID',
  'KORTIX_PROJECT_ID',
  'KORTIX_FRONTEND_URL',
  'KORTIX_SUPERVISED',
  'KORTIX_MODEL',
  'KORTIX_OPENCODE_MODEL',
  'KORTIX_BASE_SHA',
  'KORTIX_BASE_REF',
  'KORTIX_DEFAULT_BRANCH',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
  'KORTIX_COMPILED_RUNTIME_FORMAT',
  'KORTIX_LLM_BASE_URL',
  'KORTIX_LLM_PROXY_URL',
  'KORTIX_CLONE_FILTER',
  'BASH_ENV',
]) {
  delete process.env[key]
}
