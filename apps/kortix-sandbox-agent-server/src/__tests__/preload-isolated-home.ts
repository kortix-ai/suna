// Test preload: isolate the machine, so every test sees a developer box.
//
// The suite's contracts assume none of the runtime box's state: no live session
// environment, no baked assets, no host-written platform env, a resolvable
// `localhost`. On a runtime box — a session sandbox, a CI/worker container —
// every one of those exists, and tests that assert the dev-box behavior read
// the box instead (2026-10-03: 17 red tests on a runtime box, all green on
// dev). One preload, so the isolation is uniform and test files cannot forget
// it. Two prior incidents set the pattern:
//
// 1. HOME (2026-09-28). On a developer machine `$HOME/.local/bin/kortix` is the
//    real Kortix CLI; a runtime-assets test once overwrote it with its fixture
//    bytes through the writable-PATH fallback.
// 2. Ambient `KORTIX_*` (2026-10-03). A runtime box exports the live session's
//    variables (KORTIX_HARNESS, KORTIX_REPO_URL, …); tests set their own, and
//    the ambient values decided what `loadConfig`/`resolveHarness` saw before
//    they could.
import { accessSync, constants, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))

// 2. Ambient runtime environment. Keep only what this preload itself set.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('KORTIX_') && name !== 'KORTIX_TEST_REAL_HOME') delete process.env[name]
}

// 3. Baked assets and the platform env file. Every path is overridable in the
//    box-paths / agent-state readers it belongs to; point each at a fresh temp
//    path so `existsSync` behaves exactly as on a developer box, where these
//    paths do not exist. A live directory (state, skills) is also fine — empty
//    is the dev-box state for both.
const box = mkdtempSync(join(tmpdir(), 'kortixd-test-box-'))
process.env.KORTIX_MANAGED_SKILLS_DIR = join(box, 'managed-skills')
process.env.KORTIX_AGENT_STATE_DIR = join(box, 'agent-state')
process.env.KORTIX_AGENT_BIN = join(box, 'agent-bin')
process.env.KORTIX_SCAFFOLD_REPO_PATH = join(box, 'scaffold.git')
process.env.KORTIX_BAKED_LLM_CATALOG_PATH = join(box, 'llm-catalog.json')
process.env.KORTIX_PT_ENV_PATH = join(box, 'pt-env')

// 4. `localhost`. On a locked-down runtime the hosts file is not readable by
//    the test user, so name resolution of `localhost` fails before any dial —
//    `fetch('http://localhost:…')` answers "Unable to connect" even for a
//    server this same process just bound. Rewrite loopback names to the
//    loopback address for this process only, and only when the hosts file
//    really cannot serve the name (a developer box or CI resolves normally,
//    and keeps resolving `localhost` as itself).
function hostsFileServesLocalhost(): boolean {
  try {
    accessSync('/etc/hosts', constants.R_OK)
    return /^localhost\s/im.test(readFileSync('/etc/hosts', 'utf8'))
  } catch {
    return false
  }
}

if (!hostsFileServesLocalhost()) {
  const realFetch = globalThis.fetch
  const rewrite = (url: string): string =>
    url.replace(/^(https?:\/\/)localhost(?=[/:?#]|$)/i, '$1127.0.0.1')
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string') return realFetch(rewrite(input), init)
    if (input instanceof URL) return realFetch(rewrite(input.href), init)
    return realFetch(input, init)
  }) as typeof fetch
}
