/**
 * Ordering contracts inside `harness/pi/boot.ts` (and one absence check on
 * `harness/open-code/boot.ts`) that no behavioral test reaches yet.
 *
 * These source guards are the cheapest independent proof of each ordering
 * below. They are the ONLY source-text assertions allowed on these files.
 *
 * Rules for this file:
 * - Read sources through `stripComments()` first. A guard that
 *   matched a word inside a comment once passed with the `return` it named
 *   deleted from the code.
 * - Anchor each assertion inside the function or block that owns it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Source with `//` and `/* *\/` comments removed; string and template literal
 *  contents (URLs included) are kept. */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    out += ch
    i += 1
  }
  return out
}

const BOOT = stripComments(readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'boot.ts'), 'utf8'))
const PI_BOOT = stripComments(readFileSync(join(import.meta.dir, '..', 'harness', 'pi', 'boot.ts'), 'utf8'))

/** Every index of `needle` must be > -1 and strictly increasing. */
function expectOrder(body: string, needles: string[]): void {
  let at = -1
  for (const needle of needles) {
    const found = body.indexOf(needle, at + 1)
    expect({ needle, found: found > at }).toEqual({ needle, found: true })
    at = found
  }
}

describe('runPi: the config and the workspace are independent', () => {
  test('pi starts on the config release alone; only the turns wait for the workspace', () => {
    // pi-ready used to wait for the checkout and then for a copy of it. The
    // config provider downloads its own release, so the runtime starts as
    // soon as that release is proven.
    expect(PI_BOOT).toContain('harness.releases.boot(bootMark)')
    expect(PI_BOOT).not.toMatch(/releases\.boot\([^)]*,/)
    expectOrder(PI_BOOT, [
      'const configReady = harness.releases.boot(bootMark)',
      'provideWorkspace(cfg, {',
      'await configReady',
      'await harness.lifecycle.start()',
      'await workspace\n',
      'runSandboxOnBoot(cfg)',
      'runtime.admit(',
    ])
    // The one wait before the start: releases off, where the working tree IS the config.
    expect(PI_BOOT.slice(PI_BOOT.indexOf('await configReady'), PI_BOOT.indexOf('await harness.lifecycle.start()'))).toContain(
      'if (harness.releases.projectRoot() === undefined) await workspace',
    )
  })

  test('the workspace writes nothing into the boot timeline', () => {
    for (const src of [PI_BOOT, BOOT]) {
      expect(src).not.toContain("'repo-materialized'")
      expect(src).not.toMatch(/provideWorkspace\([^)]*bootMark/)
    }
  })
})
