/**
 * T4 — the running config state has exactly one writer, checked against the
 * real source with the TypeScript AST. The scanners live in
 * `helpers/boot-path-rules.ts`, which `scripts/boot-path-rules-proof.ts` also
 * runs.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { parse, productionSources, runningWriteLeaks, runningWriters, type ScannedFile } from './helpers/boot-path-rules'

const sourceRoot = resolve(import.meta.dir, '..')
const sources = await productionSources(sourceRoot)
const file = (name: string): ScannedFile => sources.find((entry) => entry.name === name)!

describe('the one boot path is enforced, not merely intended', () => {
  test('T4 on pi — its running config has exactly one writer too, and it is setCurrent', () => {
    expect(runningWriters(file('harness/pi/config-release.ts').source, 'current')).toEqual(['setCurrent:current'])
  })

  test('T4 negative — a field patch outside the setter is caught', () => {
    const probe = parse(
      'function setRunningConfig(n){ running = { ...running, ...n } }\n' +
        'function elsewhere(){ running.proven = true }',
    )
    expect(runningWriters(probe)).toEqual(['setRunningConfig:running', 'elsewhere:running.proven'])
    expect(runningWriteLeaks([{ name: 'harness/open-code/boot.ts', source: probe }])).toEqual([
      'harness/open-code/boot.ts',
    ])
  })
})
