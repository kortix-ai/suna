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

/**
 * kortixd is also a pnpm workspace package. Every CI job that runs
 * `pnpm install --frozen-lockfile` at the repo root fails when pnpm-lock.yaml
 * lacks a spec package.json declares: `bun add` updates bun.lock only
 * (2026-10-31, deploy-dev 41172695941 lost its frontend image, DB migrations and
 * CLI). Regenerate with `pnpm install --lockfile-only` at the repo root.
 */
test('pnpm-lock.yaml records the dependency specs package.json declares', () => {
  const root = join(import.meta.dir, '../..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = readFileSync(join(root, '../../pnpm-lock.yaml'), 'utf8')
  const start = lock.indexOf('\n  apps/kortix-sandbox-agent-server:\n')
  expect(start).toBeGreaterThan(-1)
  // The importer block ends at the next importer (two-space indent) or section.
  const rest = lock.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}\S|\n\S/)
  const block = end === -1 ? rest : rest.slice(0, end + 1)
  const specs = (section: string) => {
    const at = block.indexOf(`\n    ${section}:\n`)
    if (at === -1) return {}
    const out: Record<string, string> = {}
    const lines = block.slice(at + section.length + 7).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const name = lines[i]!.match(/^ {6}'?([^':]+)'?:$/)
      if (!name) {
        if (/^ {4}\S/.test(lines[i]!) || /^ {0,2}\S/.test(lines[i]!)) break
        continue
      }
      const spec = lines[i + 1]?.match(/^ {8}specifier: '?([^']+)'?$/)
      if (spec) out[name[1]!] = spec[1]!
    }
    return out
  }
  expect({ dependencies: specs('dependencies'), devDependencies: specs('devDependencies') }).toEqual({
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
  })
})
