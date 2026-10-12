import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The API image builds kortixd standalone with `bun install --frozen-lockfile`
 * (apps/api/Dockerfile, stage `sandbox-agent`). That install fails when a
 * dependency spec in package.json differs from the one bun.lock recorded, and
 * no API image builds (#8563, #8738). Regenerate with
 * `bun install --lockfile-only --minimum-release-age=259200` in this directory.
 */
test('bun.lock records the dependency specs package.json declares', () => {
  const root = join(import.meta.dir, '../..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  // bun.lock is JSON with trailing commas.
  const lock = JSON.parse(readFileSync(join(root, 'bun.lock'), 'utf8').replace(/,(\s*[}\]])/g, '$1'))
  const locked = lock.workspaces['']
  expect({ dependencies: locked.dependencies ?? {}, devDependencies: locked.devDependencies ?? {} }).toEqual({
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
  })
})
