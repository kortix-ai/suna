// Test preload: isolate this package's tests from the platform image they run
// inside. On a developer machine `$HOME/.local/bin/kortix` is the real Kortix
// CLI; a runtime-assets test once overwrote it with its fixture bytes through
// the writable-PATH fallback (2026-09-28) — hence the isolated HOME.
//
// CI runs with none of the platform's runtime state, so "CI-identical" is the
// hermeticity bar. A platform-managed sandbox adds CI never has:
//
// 1. KORTIX_* runtime context in the process env (session id, supervised flag,
//    API URL and token, project id, agent config). The code under test reads
//    it: a session id adds a `· session <id>` breadcrumb to host lines, an API
//    URL + token authenticate the spawned CLI, KORTIX_SUPERVISED redirects
//    self-update paths. Tests that exercise that behavior set what they need
//    themselves.
// 2. Image-baked state the code reads at call time: `/etc/pt-env` (host-health
//    reads it as an authority for the session's branch and auto-clone state,
//    so a rig with no repository reports repo_required=true and fails every
//    runtimeReady assertion), `/opt/kortix/llm-catalog.json` (the boot catalog
//    falls through to it instead of the minimal bundled set), and
//    `/opt/kortix/managed-skills` (the pi harness loads its 44 platform skills
//    into every rig's system prompt, so a rig asserting its own two project
//    skills receives them instead).
//
// Both are already neutralized by the packages lane itself:
// tests/bin/package-quality.ts `hermeticWorkspaceEnv()` scrubs KORTIX_* and
// points `KORTIX_PT_ENV_PATH`, `KORTIX_BAKED_LLM_CATALOG_PATH` and
// `KORTIX_MANAGED_SKILLS_DIR` at paths that do not exist, which is exactly
// what the three read sites consult (`ptEnvPath()`, `bakedCatalogPath()`,
// `managedSkillsDir()`). Keep those pointers alive here, drop every other
// KORTIX_* var, and isolate HOME. A run outside the lane on a laptop or CI
// has no baked state to begin with, so the same CI condition holds. A test
// that needs platform-shaped state writes its own (the injectSkills rig, the
// runtime-assets fixtures, the scaffold pointer in materialize-repo.test.ts).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL_HOME = process.env.HOME ?? ''
// The lane's own inputs (package-quality): its runner controls and the three
// baked-state pointers. Everything else KORTIX_* is platform context, not
// test input.
const HARNESS_KNOBS = new Set([
  'KORTIX_TEST_TIMEOUT_MS',
  'KORTIX_ATTACHMENT_OFFLOAD',
  'KORTIX_PT_ENV_PATH',
  'KORTIX_BAKED_LLM_CATALOG_PATH',
  'KORTIX_MANAGED_SKILLS_DIR',
])
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KORTIX_') && !HARNESS_KNOBS.has(key)) delete process.env[key]
}
process.env.KORTIX_TEST_REAL_HOME = REAL_HOME
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))
