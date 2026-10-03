// Test preload: isolate HOME. On a developer machine `$HOME/.local/bin/kortix`
// is the real Kortix CLI; a runtime-assets test once overwrote it with its
// fixture bytes through the writable-PATH fallback (2026-09-28).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))

// The host-written env file exists only inside a sandbox VM, where it describes
// THIS session (branch, auto-clone). Left alone it flips every rig's
// repo-readiness gate for host state no test set up; tests read the default
// once at module load (host-health.ts), so it must be set here, before any
// test module loads. host-health's __setPtEnvPathForTests re-points it for a
// test that wants the file.
process.env.KORTIX_TEST_PT_ENV_PATH = join(tmpdir(), 'kortix-test-absent-pt-env')
