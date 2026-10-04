// Test preload: isolate this package's tests from the platform image they run
// inside. On a developer machine `$HOME/.local/bin/kortix` is the real Kortix
// CLI; a runtime-assets test once overwrote it with its fixture bytes through
// the writable-PATH fallback (2026-09-28) — hence the isolated HOME.
//
// CI runs with none of the platform's runtime state, so "CI-identical" is the
// hermeticity bar. A platform-managed sandbox adds three things CI never has:
//
// 1. KORTIX_* runtime context in the process env (session id, supervised flag,
//    API URL and token, project id, agent config). The code under test reads
//    it: a session id adds a `· session <id>` breadcrumb to host lines, an API
//    URL + token authenticate the spawned CLI, KORTIX_SUPERVISED redirects
//    self-update paths. Tests that exercise that behavior set what they need
//    themselves.
// 2. `/etc/pt-env` — the session's real environment file, baked into the image.
//    host-health.ts reads it as an authority for the session's branch and
//    auto-clone state (`sessionWantsRepo`, `wantedSessionBranch`), so a rig
//    with no repository suddenly reports repo_required=true and fails every
//    runtimeReady assertion. No test reads pt-env on purpose.
// 3. `/opt/kortix/managed-skills` — the image-baked system skills. The pi
//    harness loads them into every rig's system prompt, so a rig asserting its
//    own two project skills receives forty-four platform ones instead.
//
// Neutralize all three to the CI condition. A test that needs platform-shaped
// state writes its own (the injectSkills rig, the runtime-assets fixtures).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

// Capture the real implementations BEFORE mock.module registers the wrapper,
// so the delegation target cannot be redirected to the wrapper itself.
const realFs = require('node:fs') as typeof import('node:fs')
const realReadFileSync = realFs.readFileSync

const REAL_HOME = process.env.HOME ?? ''
// The harness's own knobs (package-quality passes these to every workspace
// test); everything else KORTIX_* is platform context, not test input.
const HARNESS_KNOBS = new Set(['KORTIX_TEST_TIMEOUT_MS', 'KORTIX_ATTACHMENT_OFFLOAD'])
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KORTIX_') && !HARNESS_KNOBS.has(key)) delete process.env[key]
}
// The sandbox also exports the session env file as BASH_ENV; every bash this
// suite spawns (rig hooks, git wrappers) would source it and re-import the
// platform context the loop above just removed. CI has no BASH_ENV.
Reflect.deleteProperty(process.env, 'BASH_ENV')
// The pi harness reads this dir through managedSkillsDir() at call time; point
// it at a fresh empty dir so no baked system skills leak into a rig.
process.env.KORTIX_MANAGED_SKILLS_DIR = mkdtempSync(join(tmpdir(), 'kortixd-test-no-skills-'))
process.env.KORTIX_TEST_REAL_HOME = REAL_HOME
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))

// `/etc/pt-env` does not exist on CI; reads of it see the CI condition (an
// empty file) here. Every other read delegates unchanged.
mock.module('node:fs', () => ({
  ...realFs,
  readFileSync(path: unknown, ...rest: unknown[]) {
    if (path === '/etc/pt-env') return ''
    // CI has no image-baked model catalog either; readCatalogFile falls back
    // to the minimal bundled set exactly as it does there.
    if (path === '/opt/kortix/llm-catalog.json') {
      const err = new Error("ENOENT: no such file or directory, open '/opt/kortix/llm-catalog.json'") as NodeJS.ErrnoException
      err.code = 'ENOENT'
      err.errno = -2
      throw err
    }
    return realReadFileSync(path, ...(rest as Parameters<typeof realReadFileSync>))
  },
}))
