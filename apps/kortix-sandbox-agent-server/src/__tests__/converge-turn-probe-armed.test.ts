import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The last-moment swap cancel only exists when the convergence is given a turn
 * probe: `config-release.ts` computes `mayPromote: deps.turnInFlight ? idle :
 * undefined`, so a caller that omits `turnInFlight` silently disables it.
 *
 * `boot.ts` supplies the probe for the boot-scheduled convergence. The API
 * reaches a box ONLY through `POST /kortix/config/converge` -> `control.ts`,
 * and that call site shipped without the probe: every production convergence
 * ran with the cancel disabled, leaving the API's pre-download turn read as the
 * only check — the exact TOCTOU the cancel was written to close. It passed
 * review because every unit test hands `turnInFlight` in by hand, and the route
 * test asserts against a stubbed control service, so nothing exercised
 * `createOpenCodeControlService` -> `convergeConfigRelease`.
 *
 * This test reads the two call sites directly. It is deliberately a source
 * check, not a behaviour check: the omission is invisible at runtime — an
 * unarmed cancel does not throw, it just never fires.
 */

const harness = resolve(import.meta.dir, '..', 'harness', 'open-code')

/** The argument object a named call passes, brace-matched from the source. */
function callArguments(source: string, callee: string): string[] {
  const out: string[] = []
  const needle = `${callee}(`
  let from = 0
  for (;;) {
    const start = source.indexOf(needle, from)
    if (start === -1) break
    from = start + needle.length
    let depth = 1
    let i = from
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    out.push(source.slice(from, i - 1))
  }
  return out
}

describe('the swap cancel is armed wherever a convergence is started', () => {
  test('the scanner reads the arguments of a call', () => {
    const src = 'convergeConfigRelease({ cfg, opencode, turnInFlight: () => probe() })'
    expect(callArguments(src, 'convergeConfigRelease')).toEqual([
      '{ cfg, opencode, turnInFlight: () => probe() }',
    ])
    expect(callArguments('nothing here', 'convergeConfigRelease')).toEqual([])
  })

  test('every caller of convergeConfigRelease passes turnInFlight', () => {
    const offenders: string[] = []
    for (const file of ['control.ts', 'boot.ts']) {
      const source = readFileSync(resolve(harness, file), 'utf8')
      callArguments(source, 'convergeConfigRelease').forEach((args, index) => {
        if (!args.includes('turnInFlight')) {
          offenders.push(`${file}: convergeConfigRelease call #${index + 1} has no turnInFlight`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  test('the route path is one of those callers — control.ts starts a convergence', () => {
    const source = readFileSync(resolve(harness, 'control.ts'), 'utf8')
    // Anti-vacuous: if the call moves out of control.ts the test above passes
    // for the wrong reason, so pin that this file still starts one.
    expect(callArguments(source, 'convergeConfigRelease').length).toBeGreaterThan(0)
  })
})
