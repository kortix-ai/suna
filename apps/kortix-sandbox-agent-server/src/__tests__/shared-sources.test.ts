/**
 * kortixd bundles a few files from outside this package (the API contract, the generative-UI prompt and
 * the SDK's message-id codec) through tsconfig paths. `KORTIXD_SHARED_SOURCES`
 * names them: apps/api fingerprints them with this source, so a change to one
 * rebuilds sandbox images, and the Dockerfiles copy them into the build stage.
 * An import missing from that list ships a binary whose image never rebuilds,
 * or a Docker build that cannot resolve it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { KORTIXD_SHARED_SOURCES } from '@kortix/api-contract/sandbox-layout'

const APP = resolve(import.meta.dir, '../..')
const REPO = resolve(APP, '../..')

/** tsconfig.json `paths` for the two shared roots, as repo-relative files. */
function sharedFileFor(specifier: string): string | null {
  if (specifier === '@kortix/sdk/genui') return 'packages/sdk/src/genui/index.ts'
  if (specifier === '@kortix/sdk/wire-message-id') return 'packages/sdk/src/core/session/wire-message-id.ts'
  const contract = /^@kortix\/api-contract\/([a-z-]+)$/.exec(specifier)
  return contract ? `packages/api-contract/src/${contract[1]}.ts` : null
}

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** Every repo-relative file `file` reaches through relative imports and re-exports, itself included. */
function relativeClosure(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const match of readFileSync(join(REPO, file), 'utf8').matchAll(/from '(\.[^']*)'/g)) {
    relativeClosure(relative(REPO, resolve(REPO, dirname(file), `${match[1]}.ts`)), seen)
  }
  return seen
}

const imported = new Map<string, string>()
for (const file of productionFiles(join(APP, 'src'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/from '(@kortix\/[^']+)'/g)) {
    const shared = sharedFileFor(match[1]!)
    if (!shared) throw new Error(`${relative(APP, file)} imports ${match[1]}, which kortixd cannot resolve standalone`)
    // The genui entry re-exports its siblings; the whole closure ships with it.
    const closure = shared.startsWith('packages/sdk/src/genui/') ? relativeClosure(shared) : [shared]
    for (const path of closure) imported.set(path, relative(APP, file))
  }
}

describe('the files kortixd bundles from outside its package', () => {
  test('KORTIXD_SHARED_SOURCES lists exactly the files the daemon imports', () => {
    expect([...imported.keys()].sort()).toEqual([...KORTIXD_SHARED_SOURCES].sort())
  })

  test.each(['apps/sandbox/Dockerfile', 'apps/api/Dockerfile'])('%s copies every one into the build stage', (dockerfile) => {
    const text = readFileSync(join(REPO, dockerfile), 'utf8')
    for (const file of KORTIXD_SHARED_SOURCES) {
      const copied = file.startsWith('packages/api-contract/')
        ? text.includes('COPY packages/api-contract /repo/packages/api-contract')
        : file.startsWith('packages/sdk/src/genui/')
          ? text.includes('COPY packages/sdk/src/genui /repo/packages/sdk/src/genui')
          : text.includes(`COPY ${file} /repo/${file}`)
      expect(copied, file).toBe(true)
    }
  })
})
