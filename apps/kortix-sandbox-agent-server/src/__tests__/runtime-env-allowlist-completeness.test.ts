/**
 * T3 — allowlist-completeness guard for `OPENCODE_RUNTIME_ENV_NAMES`
 * (routes/env.ts).
 *
 * That Set is the ONLY gate deciding which names a `/kortix/env` push may
 * write into `process.env` for opencode to consume (see
 * `applyOpencodeRuntimeEnv`'s `if (!OPENCODE_RUNTIME_ENV_NAMES.has(name))
 * continue`). A name opencode actually reads while building its config or
 * spawning its child, but that is NOT on this list, is an env key the API can
 * never deliver mid-session: the push silently no-ops on that field forever,
 * with no error — the exact "under-reloading" failure mode this suite exists
 * to catch, distinct from (and the mirror image of) the over-reloading this
 * ticket's api-side change fixes.
 *
 * This test enumerates every `env.KORTIX_*` (or `env[NAME_CONST]`) READ in
 * opencode.ts's config-construction and spawn-time paths by pattern-matching
 * the real source — not a hand-maintained list a future edit can silently
 * drift from — then asserts each one is either:
 *
 *   (a) in `OPENCODE_RUNTIME_ENV_NAMES`, or
 *   (b) in `BOOT_ONLY_KORTIX_ENV_NAMES` below, a short, individually justified
 *       list of names that are session-boot constants and are deliberately
 *       never pushed through `/kortix/env`.
 *
 * Adding a NEW `env.KORTIX_FOO` read to opencode.ts's config path with
 * neither of the above fails this test immediately, rather than shipping a
 * config field nobody can ever update on a running box.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const OPENCODE_SRC = readFileSync(join(import.meta.dir, '..', 'opencode.ts'), 'utf8')
const ENV_ROUTE = readFileSync(join(import.meta.dir, '..', 'routes', 'env.ts'), 'utf8')
const SECRET_CAPABILITIES_SRC = readFileSync(
  join(import.meta.dir, '..', 'secret-capabilities.ts'),
  'utf8',
)

/** The allowlist body, parsed the same way `compiled-agent-config-env.test.ts` does. */
function runtimeEnvAllowlist(): Set<string> {
  const body = ENV_ROUTE.split('const OPENCODE_RUNTIME_ENV_NAMES = new Set([')[1]?.split('])')[0]
  expect(body).toBeTruthy()
  return new Set([...(body as string).matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1] as string))
}

/**
 * Every `KORTIX_*` name read off an `env`-shaped object (`env.KORTIX_FOO` or
 * `env['KORTIX_FOO']`) anywhere in a source string. Deliberately broad — it is
 * meant to over-collect (e.g. `process.env.KORTIX_OPENCODE_DEBUG` matches
 * too) rather than under-collect, because a missed read is exactly the bug
 * this test exists to catch. Over-collection is handled by
 * `BOOT_ONLY_KORTIX_ENV_NAMES` below, not by narrowing the pattern.
 */
function readKortixEnvNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const m of source.matchAll(/\benv(?:\.|\[['"])(KORTIX_[A-Z0-9_]+)/g)) {
    names.add(m[1] as string)
  }
  return names
}

/**
 * Session-boot constants that opencode's config path reads but the API never
 * pushes through `/kortix/env` — each has its own reason it is not, and must
 * not become, part of the live-update contract. Moving a name OFF this list
 * without adding it to `OPENCODE_RUNTIME_ENV_NAMES` is exactly the failure
 * this test is built to catch.
 */
const BOOT_ONLY_KORTIX_ENV_NAMES = new Set([
  // Connector MCP identity, materialized once at provision. A rotated
  // connector token is a new session, not a live push.
  'KORTIX_API_URL',
  'KORTIX_TOKEN',
  // Warm-fork proxy-mode flag. Daemon-injected at boot so a warm seed's
  // provider config is session-independent; never posted by the API — see
  // buildOpencodeConfigContent's comment on `llmProxyUrl`/`connectorProxyUrl`.
  // (KORTIX_LLM_PROXY_URL moved to OPENCODE_RUNTIME_ENV_NAMES: a live
  // gateway→native toggle must be able to CLEAR it, because a set proxy URL
  // reads as "gateway on" in hasKortixLlmGateway.)
  'KORTIX_CONNECTORS_PROXY_URL',
  // Local catalog-file override; operator/dev-only, not an API-driven field.
  'KORTIX_LLM_CATALOG_FILE',
  // Manual operator debug toggle (checked against `process.env` directly, not
  // part of the env-sync contract at all).
  'KORTIX_OPENCODE_DEBUG',
  // Artifact identity is fixed before PID 1 starts. A live update installs a
  // new artifact and daemon instead of changing this value through /env.
  'KORTIX_COMPILED_RUNTIME_FORMAT',
  // Static project identity baked at seed — see the comment beside its read.
  'KORTIX_PROJECT_ID',
])

describe('OPENCODE_RUNTIME_ENV_NAMES — allowlist completeness', () => {
  test('every KORTIX_* name opencode.ts reads is accounted for', () => {
    const allowlist = runtimeEnvAllowlist()
    const consumed = readKortixEnvNames(OPENCODE_SRC)
    // `KORTIX_SECRET_CAPABILITIES` is read via the shared
    // `SECRET_CAPABILITIES_ENV_NAME` constant in secret-capabilities.ts
    // (`env[SECRET_CAPABILITIES_ENV_NAME]`), not as a literal `env.KORTIX_...`
    // in opencode.ts, so the pattern above cannot see it directly. Confirm the
    // indirection actually resolves to that literal name before folding it in
    // — this is the one name in the set the regex must be TOLD about instead
    // of discovering, and it must stay provably tied to the real constant.
    expect(SECRET_CAPABILITIES_SRC).toContain("SECRET_CAPABILITIES_ENV_NAME = 'KORTIX_SECRET_CAPABILITIES'")
    expect(SECRET_CAPABILITIES_SRC).toContain('env[SECRET_CAPABILITIES_ENV_NAME]')
    expect(OPENCODE_SRC).toContain('writeSecretCapabilitiesInstruction(baseEnv)')
    consumed.add('KORTIX_SECRET_CAPABILITIES')

    const unaccounted = [...consumed].filter(
      (name) => !allowlist.has(name) && !BOOT_ONLY_KORTIX_ENV_NAMES.has(name),
    )

    // A name landing here means opencode.ts (or its secret-capabilities
    // helper) now reads a KORTIX_* env var that `/kortix/env` has no way to
    // update on a running box. Resolve it by adding the name to
    // OPENCODE_RUNTIME_ENV_NAMES in routes/env.ts (it should be
    // live-updatable) or to BOOT_ONLY_KORTIX_ENV_NAMES above with a one-line
    // reason it is boot-only forever.
    expect(unaccounted).toEqual([])
  })

  test('the two lists do not overlap — a name is EITHER live-updatable or boot-only, never both', () => {
    const allowlist = runtimeEnvAllowlist()
    const overlap = [...BOOT_ONLY_KORTIX_ENV_NAMES].filter((name) => allowlist.has(name))
    expect(overlap).toEqual([])
  })

  test('the boot-only list is not stale — every name on it is still actually read', () => {
    // Guards the exclusion list itself: a name that stops being read at all
    // should be deleted from here rather than silently kept "just in case".
    const consumed = readKortixEnvNames(OPENCODE_SRC)
    const stale = [...BOOT_ONLY_KORTIX_ENV_NAMES].filter((name) => !consumed.has(name))
    expect(stale).toEqual([])
  })

  test('pins the current fully-enumerated set, so a change here is a deliberate, reviewed diff', () => {
    const consumed = readKortixEnvNames(OPENCODE_SRC)
    consumed.add('KORTIX_SECRET_CAPABILITIES')
    expect([...consumed].sort()).toEqual([
      'KORTIX_API_URL',
      'KORTIX_COMPILED_AGENT_CONFIG',
      'KORTIX_COMPILED_RUNTIME_FORMAT',
      'KORTIX_CONNECTORS_MCP_ENABLED',
      'KORTIX_CONNECTORS_PROXY_URL',
      'KORTIX_LLM_BASE_URL',
      'KORTIX_LLM_CATALOG_FILE',
      'KORTIX_LLM_PROXY_URL',
      'KORTIX_OPENCODE_DEBUG',
      'KORTIX_OPENCODE_MODEL',
      'KORTIX_PROJECT_ID',
      'KORTIX_SECRET_CAPABILITIES',
      'KORTIX_TOKEN',
    ])
  })
})
