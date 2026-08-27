import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// Shape assertions over the boot sequence (a unit suite cannot boot OpenCode).
// They keep the sub-marks that decompose `opencode-ready` — and the early
// initial-turn claim — from being quietly dropped.
const MAIN = readFileSync(join(import.meta.dir, '..', 'main.ts'), 'utf8')
const OPENCODE = readFileSync(join(import.meta.dir, '..', 'opencode.ts'), 'utf8')

describe('boot instrumentation', () => {
  test('the initial-turn claim is prefetched at proxy-up, before the clone is awaited', () => {
    const proxyUp = MAIN.indexOf("bootMark('proxy-up')")
    const earlyClaim = MAIN.indexOf('void claimInitialTurnFromApi()', proxyUp)
    const repoAwait = MAIN.indexOf('await repoMaterializePromise', proxyUp)
    expect(proxyUp).toBeGreaterThan(-1)
    expect(earlyClaim).toBeGreaterThan(proxyUp)
    expect(repoAwait).toBeGreaterThan(earlyClaim)
  })

  test('every stage of the initial-session path has its own mark, in order', () => {
    const start = MAIN.indexOf('async function maybeCreateInitialOpencodeSession')
    const order = [
      "bootMark('initial-turn-claimed')",
      "bootMark('opencode-answering')",
      "bootMark('opencode-root-created')",
      "bootMark('opencode-root-ready')",
      "bootMark('initial-prompt-delivered')",
    ]
    let cursor = start
    for (const mark of order) {
      const at = MAIN.indexOf(mark, cursor)
      expect(at, mark).toBeGreaterThan(cursor)
      cursor = at
    }
    const finalize = MAIN.indexOf('const finalizeInitialSession = async () => {')
    const accepted = MAIN.indexOf("bootMark('initial-turn-accepted')", finalize)
    const ready = MAIN.indexOf("bootMark('opencode-ready')", finalize)
    expect(accepted).toBeGreaterThan(finalize)
    expect(ready).toBeGreaterThan(accepted)
  })

  test('the supervisor reports the first HTTP response separately from the first 200', () => {
    expect(OPENCODE).toContain('onFirstListeningResponse?: () => void')
    const probe = OPENCODE.indexOf("const probe = await probeOpencodeReadiness(")
    const report = OPENCODE.indexOf('options.onFirstListeningResponse?.()', probe)
    expect(probe).toBeGreaterThan(-1)
    expect(report).toBeGreaterThan(probe)
    expect(MAIN).toContain("bootMark('opencode-http-listening')")
  })
})
