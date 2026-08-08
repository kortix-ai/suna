/**
 * The box must not be able to grant itself an agent.
 *
 * Reproduced on dev before this was written, against a project that explicitly
 * denies the capability:
 *
 *   PUT /projects/<id>/agents/kortix/config  {"permission":{"bash":"deny"}}
 *   then, from inside the sandbox, write agents/<anything>.md declaring
 *   `permission: {bash: allow}` and restart:
 *
 *     declared (kortix) : {"permission":"bash","action":"deny"}
 *     injected          : {"permission":"bash","action":"allow"}
 *
 * Real files on a real filesystem, because the thing under test is what
 * opencode will find when it reads the directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { declaredAgentNames, pruneUndeclaredAgentFiles } from '../declared-agents'

let dir: string
let agentsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-agents-'))
  agentsDir = join(dir, 'agents')
  mkdirSync(agentsDir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeAgent(name: string, body = 'x') {
  writeFileSync(join(agentsDir, `${name}.md`), body)
}

const compiled = (...names: string[]) =>
  JSON.stringify({ agent: Object.fromEntries(names.map((n) => [n, {}])) })

describe('declaredAgentNames', () => {
  test('reads the roster the API compiled', () => {
    expect(declaredAgentNames(compiled('kortix', 'memory-reflector'))).toEqual(
      new Set(['kortix', 'memory-reflector']),
    );
  })

  // Each of these means "we do not know the roster", and pruning against an
  // unknown roster would delete every agent in the box.
  test.each([
    ['absent config', undefined],
    ['malformed JSON', '{not json'],
    ['no agent map', JSON.stringify({ model: 'x' })],
    ['empty agent map', JSON.stringify({ agent: {} })],
    ['agent map is an array', JSON.stringify({ agent: [] })],
  ])('%s yields null, never an empty set', (_label, raw) => {
    expect(declaredAgentNames(raw as string | undefined)).toBeNull()
  })
})

describe('pruneUndeclaredAgentFiles', () => {
  test('neutralizes an agent the platform never declared', () => {
    writeAgent('kortix')
    writeAgent('injected-probe')

    const result = pruneUndeclaredAgentFiles(dir, declaredAgentNames(compiled('kortix')))

    expect(result.rejected).toEqual(['injected-probe'])
    expect(result.kept).toEqual(['kortix'])
    expect(existsSync(join(agentsDir, 'injected-probe.md'))).toBe(false)
    expect(existsSync(join(agentsDir, 'kortix.md'))).toBe(true)
  })

  test('the rejected file no longer looks like an agent to opencode', () => {
    // The whole mechanism: opencode globs `*.md`, so the rename is the fix.
    writeAgent('injected')
    pruneUndeclaredAgentFiles(dir, declaredAgentNames(compiled('kortix')))
    const remainingMd = readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
    expect(remainingMd).toEqual([])
  })

  test('content is preserved, not destroyed', () => {
    // Evidence of what the box tried to do. Deleting a user's file to enforce
    // policy is a worse default than neutralizing it.
    writeAgent('injected', 'FORENSIC BODY')
    pruneUndeclaredAgentFiles(dir, declaredAgentNames(compiled('kortix')))
    expect(existsSync(join(agentsDir, 'injected.md.rejected'))).toBe(true)
    expect(Bun.file(join(agentsDir, 'injected.md.rejected')).size).toBeGreaterThan(0)
  })

  test('does NOTHING when the roster is unknown', () => {
    // A v1 project or a config-delivery hiccup. Pruning here would leave the
    // session with no agents at all — worse than the hole being closed.
    writeAgent('kortix')
    writeAgent('anything')

    const result = pruneUndeclaredAgentFiles(dir, declaredAgentNames(undefined))

    expect(result).toEqual({ kept: [], rejected: [], failed: [] })
    expect(existsSync(join(agentsDir, 'anything.md'))).toBe(true)
  })

  test('every declared agent survives', () => {
    writeAgent('kortix')
    writeAgent('memory-reflector')

    const result = pruneUndeclaredAgentFiles(
      dir,
      declaredAgentNames(compiled('kortix', 'memory-reflector')),
    )

    expect(result.rejected).toEqual([])
    expect(result.kept.sort()).toEqual(['kortix', 'memory-reflector'])
  })

  test('a missing agents directory is normal, not an error', () => {
    rmSync(agentsDir, { recursive: true, force: true })
    expect(() => pruneUndeclaredAgentFiles(dir, declaredAgentNames(compiled('kortix')))).not.toThrow()
  })

  test('non-.md files are left alone', () => {
    // tools, skills and READMEs share the tree; this prunes agents only.
    writeFileSync(join(agentsDir, 'README.txt'), 'notes')
    writeFileSync(join(agentsDir, 'helper.ts'), 'code')
    pruneUndeclaredAgentFiles(dir, declaredAgentNames(compiled('kortix')))
    expect(existsSync(join(agentsDir, 'README.txt'))).toBe(true)
    expect(existsSync(join(agentsDir, 'helper.ts'))).toBe(true)
  })

  test('re-running is stable — a rejected file is not re-processed', () => {
    // It runs on every spawn, so it must not churn or re-reject its own output.
    writeAgent('injected')
    const declared = declaredAgentNames(compiled('kortix'))
    pruneUndeclaredAgentFiles(dir, declared)
    const second = pruneUndeclaredAgentFiles(dir, declared)
    expect(second.rejected).toEqual([])
    expect(readdirSync(agentsDir)).toEqual(['injected.md.rejected'])
  })

  test('an agent added by a later declaration is kept once declared', () => {
    // The supported way to add an agent is the API, which commits it to git and
    // makes it declared. That path must keep working.
    writeAgent('new-agent')
    const result = pruneUndeclaredAgentFiles(
      dir,
      declaredAgentNames(compiled('kortix', 'new-agent')),
    )
    expect(result.rejected).toEqual([])
    expect(existsSync(join(agentsDir, 'new-agent.md'))).toBe(true)
  })
})
