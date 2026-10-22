/**
 * The import boundaries hold on the real tree, and every rule is proven.
 *
 * `eslint.config.mjs` states the layers (ARCHITECTURE.md). The first test runs
 * it over `src/`. The second runs `scripts/check-architecture.mjs`, which lints
 * one probe import per rule and asserts the rule allows or rejects it, so a
 * rule that stops matching fails instead of passing silently.
 *
 * Both run as Node subprocesses: ESLint's config validation crashes under the
 * Bun runtime. This file is how `bun test` — and so the packages lane — runs
 * them. It replaces the adapter and HTTP-framework import scans that
 * `harness-boundary.test.ts` used to carry.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '../..')

function node(args: string[]): number {
  const result = Bun.spawnSync(['node', ...args], { cwd: packageDir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`node ${args.join(' ')} exited ${result.exitCode}\n${result.stdout}${result.stderr}`)
  return result.exitCode
}

describe('architecture boundaries', () => {
  test('eslint reports no boundary violation in src/', () => {
    expect(node([resolve(packageDir, 'node_modules/eslint/bin/eslint.js'), 'src'])).toBe(0)
  }, 120_000)

  test('every rule allows and rejects its contract cases, and the docs name real paths', () => {
    expect(node(['--test', 'scripts/check-architecture.mjs'])).toBe(0)
  }, 120_000)
})
