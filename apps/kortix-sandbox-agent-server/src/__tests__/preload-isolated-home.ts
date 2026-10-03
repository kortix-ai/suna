// Test preload: isolate HOME. On a developer machine `$HOME/.local/bin/kortix`
// is the real Kortix CLI; a runtime-assets test once overwrote it with its
// fixture bytes through the writable-PATH fallback (2026-09-28).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This app does not depend on @kortix/shared; import the scrub helper's
// source directly.
import { scrubHostSandboxEnv } from '../../../../packages/shared/src/host-config/test-sandbox-env'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))

// A hosted Kortix sandbox also injects its live session wiring into every
// process, and tests here spawn daemons that would adopt it. Scrub to CI's
// world; see packages/shared/src/host-config/test-sandbox-env.ts.
scrubHostSandboxEnv()

// The platform image bakes a 4.8 MB model catalog at /opt/kortix; CI has none,
// so every "no catalog" pin would read the baked set instead of the bundled
// floor. Point the path at an absent file for the whole suite.
process.env.KORTIX_BAKED_LLM_CATALOG_PATH = join(
  mkdtempSync(join(tmpdir(), 'kortixd-no-baked-catalog-')),
  'absent.json',
)

// Same class: the host writes /etc/pt-env with this session's repo wiring;
// health would then require a repo on the session branch. Point it at an
// absent file so the rigs behave as on CI.
process.env.KORTIX_PT_ENV_PATH = join(
  mkdtempSync(join(tmpdir(), 'kortixd-no-pt-env-')),
  'absent',
)
