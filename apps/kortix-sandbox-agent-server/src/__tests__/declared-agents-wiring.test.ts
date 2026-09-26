/**
 * `declared-agents.ts` (the exploit it closes: apps/kortix-sandbox-agent-server
 * /src/declared-agents.ts) is only a fix if it actually runs before OpenCode
 * reads its config directory. `spawnChild` in harness/open-code/lifecycle.ts is
 * the ONE place OpenCode is spawned (PLAN-one-boot-path T1: `OPENCODE_CONFIG_DIR`
 * is assigned exactly once, to `bootLinkPath()`, in that same function) — every
 * cold boot, respawn, and config-release candidate goes through it. This is a
 * source assertion, like restart-loss-verdict.test.ts's, because the thing
 * under test is deep inside a long-lived child_process spawn that a unit test
 * cannot reach without actually launching the opencode binary.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const lifecycle = readFileSync(
  join(import.meta.dir, '../harness/open-code/lifecycle.ts'),
  'utf8',
)

describe('opencode spawn never skips the declared-agents prune', () => {
  test('lifecycle.ts imports the prune functions', () => {
    expect(lifecycle).toContain(
      "import { declaredAgentNames, pruneUndeclaredAgentFiles } from '../../declared-agents'",
    )
  })

  test('spawnChild calls pruneUndeclaredAgentFiles before the process spawns', () => {
    const spawnFnAt = lifecycle.indexOf('async function spawnChild(')
    expect(spawnFnAt).toBeGreaterThan(-1)

    const pruneAt = lifecycle.indexOf('pruneUndeclaredAgentFiles(', spawnFnAt)
    expect(pruneAt).toBeGreaterThan(spawnFnAt)

    // The real child_process.spawn call for the opencode binary itself —
    // `const proc = spawn(bin, args, {` — must come AFTER the prune, not before.
    const processSpawnAt = lifecycle.indexOf('const proc = spawn(bin, args,', spawnFnAt)
    expect(processSpawnAt).toBeGreaterThan(pruneAt)
  })

  test('the prune call reads KORTIX_COMPILED_AGENT_CONFIG from the env spawnChild is about to hand OpenCode', () => {
    const spawnFnAt = lifecycle.indexOf('async function spawnChild(')
    const pruneAt = lifecycle.indexOf('pruneUndeclaredAgentFiles(', spawnFnAt)
    const pruneLine = lifecycle.slice(pruneAt, lifecycle.indexOf('\n', pruneAt))
    expect(pruneLine).toContain('declaredAgentNames(baseEnv.KORTIX_COMPILED_AGENT_CONFIG)')
  })
})
