/**
 * A pi bump that adds a module to pi-coding-agent's VIRTUAL_MODULES (1.4.0: `pi-ai/models`) must add
 * it to both host lists: the API's prebuild rewrites only the imports it lists, and the daemon serves
 * only the modules it maps.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VIRTUAL_MODULES } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/virtual-modules.js'
import { loadPrebuiltPackages } from '@/harness/pi/extensions/prebuilt'

test("the daemon's host modules are pi's VIRTUAL_MODULES", async () => {
  const pi = Object.keys(VIRTUAL_MODULES).sort()
  const root = mkdtempSync(join(tmpdir(), 'pi-host-modules-'))
  try {
    await loadPrebuiltPackages(root, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  expect(Object.keys((globalThis as { __kortixPiHost?: Record<string, unknown> }).__kortixPiHost ?? {}).sort()).toEqual(pi)
})

test("the daemon pins pi's typebox: bun.lock holds one copy, and extensions get the TypeBox pi validates with", () => {
  const deps = (path: string) => (JSON.parse(readFileSync(join(import.meta.dir, '../..', path), 'utf8')) as { dependencies: Record<string, string> }).dependencies
  expect(deps('package.json').typebox).toBe(deps('node_modules/@earendil-works/pi-ai/package.json').typebox)
})
