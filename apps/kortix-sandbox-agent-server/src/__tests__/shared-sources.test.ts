/**
 * kortixd bundles a few files from outside this package (the API contract and
 * the SDK's message-id codec) through tsconfig paths. `KORTIXD_SHARED_SOURCES`
 * names them: apps/api fingerprints them with this source, so a change to one
 * rebuilds sandbox images, and the Dockerfiles copy them into the build stage.
 * An import missing from that list ships a binary whose image never rebuilds,
 * or a Docker build that cannot resolve it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { KORTIXD_SHARED_SOURCES } from '@kortix/api-contract/sandbox-layout'

const APP = resolve(import.meta.dir, '../..')
const REPO = resolve(APP, '../..')

/**
 * tsconfig.json `paths` for the two shared roots, as repo-relative files. A
 * contract module that is a directory (`session-log/`) bundles every file in it.
 */
function sharedFilesFor(specifier: string): string[] | null {
  if (specifier === '@kortix/sdk/wire-message-id') return ['packages/sdk/src/core/session/wire-message-id.ts']
  const contract = /^@kortix\/api-contract\/([a-z-]+)$/.exec(specifier)
  if (!contract) return null
  const dir = `packages/api-contract/src/${contract[1]}`
  if (!existsSync(join(REPO, dir))) return [`${dir}.ts`]
  return readdirSync(join(REPO, dir))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `${dir}/${name}`)
}

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

const imported = new Map<string, string>()
for (const file of productionFiles(join(APP, 'src'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/from '(@kortix\/[^']+)'/g)) {
    const shared = sharedFilesFor(match[1]!)
    if (shared) for (const path of shared) imported.set(path, relative(APP, file))
    else throw new Error(`${relative(APP, file)} imports ${match[1]}, which kortixd cannot resolve standalone`)
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
        : text.includes(`COPY ${file} /repo/${file}`)
      expect(copied, file).toBe(true)
    }
  })
})
