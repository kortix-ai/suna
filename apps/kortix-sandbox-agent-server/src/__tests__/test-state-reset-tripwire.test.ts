import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/**
 * A `*ForTests` reset clears MODULE-LEVEL state, which every test file in a bun
 * process shares. Resetting only on the way IN protects the file that resets;
 * the file that runs next inherits whatever this one left behind.
 *
 * That is not theory. On 2026-09-25 `main`'s packages lane went red because
 * `env-route-secret-respawn.test.ts` inherited a release that owned compiled
 * governance from a file that ran before it — the suite passed alone and failed
 * in the lane, which is the worst shape a failure can take. Two separate people
 * then fixed the same red without noticing each other.
 *
 * So the rule is: a test file that calls a `*ForTests` reset in `beforeEach` or
 * `beforeAll` must also call it in the matching `afterEach` or `afterAll`. This
 * test enforces it, in the shape of the package's other tripwires
 * (`harness-boundary.test.ts`, `runtime-env-allowlist-completeness.test.ts`):
 * scan every test file, report every offender at once, and carry a negative
 * probe so a scanner that stops working cannot pass silently.
 */

const testsRoot = resolve(import.meta.dir)
const RESET_CALL = /\b(\w*(?:ForTests|ForTest))\s*\(/g
const HOOK = /\b(beforeEach|beforeAll|afterEach|afterAll)\s*\(/g

/** Every `<hook>(...)` body in a source, as {hook, body} pairs, brace-matched. */
export function hookBodies(source: string): Array<{ hook: string; body: string }> {
  const out: Array<{ hook: string; body: string }> = []
  for (const match of source.matchAll(HOOK)) {
    const open = source.indexOf('{', match.index! + match[0].length)
    if (open === -1) continue
    let depth = 0
    let end = open
    for (let i = open; i < source.length; i++) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const hook = match[1]
    if (!hook) continue
    out.push({ hook, body: source.slice(open, end + 1) })
  }
  return out
}

/** Reset helpers a source calls on the way in but never on the way out. */
export function unbalancedResets(source: string): string[] {
  const hooks = hookBodies(source)
  const setUp = new Set<string>()
  const tearDown = new Set<string>()
  for (const { hook, body } of hooks) {
    const target = hook.startsWith('before') ? setUp : tearDown
    for (const call of body.matchAll(RESET_CALL)) {
      const name = call[1]
      if (name) target.add(name)
    }
  }
  return [...setUp].filter((name) => !tearDown.has(name)).sort()
}

describe('module-level test state is cleared on the way OUT, not only on the way in', () => {
  test('the scanner sees an unbalanced reset', () => {
    const offending = [
      'beforeEach(() => {',
      '  resetThingForTests()',
      '})',
      'afterEach(() => {',
      '  api.stop()',
      '})',
    ].join('\n')
    expect(unbalancedResets(offending)).toEqual(['resetThingForTests'])
  })

  test('the scanner accepts a balanced reset, in either hook pair', () => {
    const each = 'beforeEach(() => { resetThingForTests() })\nafterEach(() => { resetThingForTests() })'
    const all = 'beforeAll(() => { resetThingForTests() })\nafterAll(() => { resetThingForTests() })'
    const crossed = 'beforeEach(() => { resetThingForTests() })\nafterAll(() => { resetThingForTests() })'
    expect(unbalancedResets(each)).toEqual([])
    expect(unbalancedResets(all)).toEqual([])
    expect(unbalancedResets(crossed)).toEqual([])
  })

  test('no daemon test file resets module state without clearing it afterwards', async () => {
    const files = [...new Bun.Glob('**/*.test.ts').scanSync(testsRoot)].map((f) => resolve(testsRoot, f))
    // Anti-vacuous: an empty or tiny scan would pass while checking nothing.
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      if (file === import.meta.path) continue
      const source = readFileSync(file, 'utf8')
      for (const name of unbalancedResets(source)) {
        offenders.push(`${relative(testsRoot, file)} calls ${name}() in a before hook and never after`)
      }
    }
    expect(offenders).toEqual([])
  })
})
