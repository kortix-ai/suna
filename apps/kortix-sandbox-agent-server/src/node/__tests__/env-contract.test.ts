/**
 * The tripwire that keeps the environment contract true.
 *
 * `env-contract.ts` is only useful if it cannot drift. This suite scans the
 * daemon source for environment reads and fails when it finds a name the
 * contract does not declare — so adding an undeclared variable is a red test,
 * not something review has to catch.
 *
 * It also fails in the other direction: a declared name nothing reads is dead
 * contract, and dead contract is how a document stops being believed.
 *
 * See docs/specs/2026-08-21-kortixd.md §5.3.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENV_CONTRACT, envNames, secretNames, sessionScopedNames } from '../env-contract'

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Names that appear in the source but are NOT environment reads — TypeScript
 * constants that happen to be SCREAMING_CASE, or fixtures. Each entry needs a
 * reason, because an over-broad ignore list is how this tripwire would quietly
 * stop working.
 */
const NOT_ENV_READS = new Map<string, string>([
  ['KORTIX_FOO', 'test fixture in env-route tests'],
  ['OPENCODE_SRC', 'test fixture path constant'],
  ['KORTIX_USER_CONTEXT_HEADER', 'exported HTTP header name, not an env var'],
  ['KORTIX_USER_CONTEXT_QUERY_PARAM', 'exported query-param name, not an env var'],
  ['KORTIX_SERVICE_CALL_HEADER', 'exported HTTP header name (kortix-user-context.ts)'],
  ['KORTIX_PTY_WS_PATH_RE', 'regex literal (proxy.ts)'],
  ['KORTIX_LLM_', 'prefix constant used for env-name matching, not a name'],
  ['OPENCODE_HOME', 'exported path constant computed in opencode.ts'],
  ['OPENCODE_DATA_HOME', 'path constant (opencode.ts)'],
  ['OPENCODE_AUTH_PATH', 'path constant (opencode.ts)'],
  ['OPENCODE_AUTH_JSON_SECRET', "const whose VALUE is 'OPENCODE_AUTH_JSON', which IS declared"],
  ['CODEX_AUTH_JSON_SECRET', "const whose VALUE is 'CODEX_AUTH_JSON', which IS declared"],
  ['OPENCODE_CONFIG_DEPS_DIR', 'exported path constant in opencode-config-deps.ts'],
  ['OPENCODE_SESSION_PIN_PATH', 'exported path constant in runtime-state.ts'],
  ['OPENCODE_SEED_BAKED_PIN_PATH', 'exported path constant in runtime-state.ts'],
  ['OPENCODE_INITIAL_PROMPT_DELIVERED_PIN_PATH', 'exported path constant'],
  ['OPENCODE_INSTALL_TIMEOUT_MS', 'timeout constant in runtime-assets.ts'],
  ['OPENCODE_HEALTH_TIMEOUT_MS', 'timeout constant in runtime-assets.ts'],
  ['OPENCODE_VERSION', 'npm version string parsed from the harness, not an env read'],
  ['OPENCODE_PLUGIN_PACKAGE', 'npm package name constant'],
  ['OPENCODE_SESSION_ID', 'regex literal (opencode-turn-state.ts, runtime-state.ts)'],
  ['OPENCODE_RUNTIME_ENV_NAMES', 'a Set of names (routes/env.ts)'],
  ['OPENCODE_CONFIG_DIR', 'name SET for the spawned harness, never read from our env'],
  ['KORTIX_RUNTIME_STATE_DIRECTORY', 'doc-comment spelling of KORTIX_RUNTIME_STATE_DIR'],
  ['KORTIX_CONTINUATION_DISABLED', 'name SET for the spawned harness (managed-opencode-env.ts)'],
])
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    // Tests may reference anything; the contract governs production code.
    if (entry.endsWith('.test.ts') || full.includes(`${'__tests__'}`)) continue
    // The contract declares names; it does not read them. Scanning it would
    // match the prose in its own doc comments.
    if (full.endsWith(join('node', 'env-contract.ts'))) continue
    acc.push(full)
  }
  return acc
}

/**
 * Strip comments before scanning. A doc comment that mentions `env.NAME` while
 * explaining the contract is not a read, and treating it as one produces a
 * failure nobody can act on.
 */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Every `process.env.NAME`, `env.NAME`, and `env['NAME']` in production code. */
function envReadsInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  // `env` is not the only name an environment object is bound to. project-env.ts
  // reads `initialEnv.KORTIX_PROJECT_SECRET_NAMES`, agent-env-file.ts uses
  // `bootEnv`, opencode.ts uses `baseEnv`/`nextEnv`. A scanner that only knew
  // `env` reported those names as DEAD CONTRACT and nearly had them deleted.
  const pattern =
    /(?:process\.env|(?<![\w.])(?:env|initialEnv|bootEnv|baseEnv|nextEnv|runtimeEnv))\s*(?:\.\s*([A-Z][A-Z0-9_]{2,})|\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\])/g
  for (const file of sourceFiles(SRC_ROOT)) {
    const body = stripComments(readFileSync(file, 'utf8'))
    for (const match of body.matchAll(pattern)) {
      const name = match[1] ?? match[2]
      if (!name) continue
      const rel = file.slice(SRC_ROOT.length + 1)
      const sites = found.get(name) ?? []
      if (!sites.includes(rel)) sites.push(rel)
      found.set(name, sites)
    }
  }
  return found
}

describe('env contract', () => {
  test('declares every environment name the source reads', () => {
    const declared = new Set(envNames())
    const undeclared: string[] = []
    for (const [name, sites] of envReadsInSource()) {
      if (declared.has(name)) continue
      if (NOT_ENV_READS.has(name)) continue
      undeclared.push(`${name}  (read in ${sites.join(', ')})`)
    }
    expect(
      undeclared,
      `Undeclared environment reads. Add them to src/node/env-contract.ts with an owner, a reload mode, and a doc line — or, if the name is a TypeScript constant rather than an env var, add it to NOT_ENV_READS with a reason.\n\n${undeclared.join('\n')}\n`,
    ).toEqual([])
  })

  test('no declared name is dead contract', () => {
    // THE OTHER DIRECTION, and the one that was missing. A name declared here
    // that nothing reads is a lie in a document people are meant to trust.
    //
    // This test was added because the first version of ENV_CONTRACT was built
    // from an IDENTIFIER grep rather than an env-read scan, so 14 of 85 entries
    // described TypeScript constants: KORTIX_PTY_WS_PATH_RE (a regex),
    // KORTIX_SERVICE_CALL_HEADER (a header name), OPENCODE_SESSION_ID (a
    // regex), and others. Its doc line even claimed KORTIX_PTY_WS_PATH_RE
    // "overrides which paths the proxy treats as a PTY websocket" — describing
    // a feature that does not exist.
    const read = envReadsInSource()
    const allSource = sourceFiles(SRC_ROOT)
      .map((f) => stripComments(readFileSync(f, 'utf8')))
      .join('\n')

    const dead: string[] = []
    for (const binding of ENV_CONTRACT) {
      if (read.has(binding.name)) continue
      // ESCAPE HATCH for a name reached through a constant or an allowlist —
      // `env[CODEX_AUTH_JSON_SECRET]`, or a name listed in SHELL_SESSION_CREDS.
      // It must still be PROVABLY tied to a real string literal in production
      // source, so `indirect: true` cannot become a way to smuggle a fiction in.
      // Same discipline as src/__tests__/runtime-env-allowlist-completeness.ts.
      if (binding.indirect && allSource.includes(`'${binding.name}'`)) continue
      dead.push(
        binding.indirect
          ? `${binding.name}  (marked indirect, but no string literal '${binding.name}' exists in production source)`
          : `${binding.name}  (declared, never read)`,
      )
    }
    expect(
      dead,
      `Dead contract. These names are declared in src/node/env-contract.ts but nothing reads them from the environment. Remove them, or — if the read happens through a constant — mark the entry \`indirect: true\` AND make sure the literal name appears in production source.\n\n${dead.join('\n')}\n`,
    ).toEqual([])
  })

  test('every name is declared exactly once', () => {
    const seen = new Map<string, number>()
    for (const binding of ENV_CONTRACT) {
      seen.set(binding.name, (seen.get(binding.name) ?? 0) + 1)
    }
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name)
    expect(duplicates).toEqual([])
  })

  test('every binding carries a real doc line', () => {
    const undocumented = ENV_CONTRACT.filter((e) => e.doc.trim().length < 15).map((e) => e.name)
    expect(undocumented).toEqual([])
  })

  test('credentials are session-scoped, never boot-cached', () => {
    // A credential that a warm-seed fork cached at boot is the deriving
    // session's credential. That is the 2026-06-10 incident, encoded as a test.
    const bootCachedSecrets = ENV_CONTRACT.filter((e) => e.secret && e.reload !== 'session').map(
      (e) => e.name,
    )
    expect(
      bootCachedSecrets,
      'A secret marked reload:boot would survive a claim and let a fork run with another session\'s credential.',
    ).toEqual([])
  })

  test('the session-scoped set covers the identity a claim replaces', () => {
    // These are exactly what armSeedAdoption() re-derives via loadConfig().
    // If one drops out of the session scope, a fork keeps the seed's value.
    const mustReload = [
      'KORTIX_SESSION_ID',
      'KORTIX_PROJECT_ID',
      'KORTIX_SANDBOX_TOKEN',
      'KORTIX_CLI_TOKEN',
      'KORTIX_BRANCH_NAME',
      'KORTIX_REPO_URL',
      'KORTIX_INITIAL_PROMPT',
    ]
    const scoped = new Set(sessionScopedNames())
    expect(mustReload.filter((n) => !scoped.has(n))).toEqual([])
  })

  test('no secret is named in a way that would leak through the health route', () => {
    // /kortix/health is unauthenticated. Nothing in the contract marked secret
    // may ever be emitted there; this asserts the list exists and is non-empty
    // so the health route has something concrete to filter against.
    expect(secretNames().length).toBeGreaterThan(0)
  })
})
