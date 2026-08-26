import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import {
  COMPILED_RUNTIME_CONTENT_TYPE,
  COMPILED_RUNTIME_FORMAT,
  buildCompiledRuntimeUrl,
  installCompiledRuntime,
} from '../compiled-runtime'

const roots: string[] = []

const config = {
  projectId: 'project-1',
  repoUrl: 'https://api.kortix.test/v1/git/project-1.git',
  defaultBranch: 'main',
  branchName: 'session-1',
  baseSha: 'a'.repeat(40),
  sandboxToken: 'sandbox-token',
} as Config

function artifact(overrides: Record<string, string> = {}): string {
  const manifest = {
    format: COMPILED_RUNTIME_FORMAT,
    engine: 'opencode',
    project_id: 'project-1',
    ref: 'main',
    source_sha: 'a'.repeat(40),
    ...overrides,
  }
  const encoded = Buffer.from(JSON.stringify(manifest)).toString('base64url')
  return `#!/usr/bin/env node
// kortix-manifest-base64url:${encoded}
export const manifest = ${JSON.stringify(manifest)};
if (process.argv.includes("--manifest")) process.stdout.write(JSON.stringify(manifest) + "\\n");
`
}

function response(source: string, headers: Record<string, string> = {}): Response {
  const sha256 = createHash('sha256').update(source).digest('hex')
  return new Response(source, {
    headers: {
      'content-type': COMPILED_RUNTIME_CONTENT_TYPE,
      'x-kortix-artifact-format': COMPILED_RUNTIME_FORMAT,
      'x-kortix-artifact-sha256': sha256,
      'x-kortix-artifact-source-sha': 'a'.repeat(40),
      ...headers,
    },
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('compiled runtime bootstrap', () => {
  test('builds the runtime URL without exposing embedded credentials', () => {
    expect(
      buildCompiledRuntimeUrl(
        'https://user:secret@api.kortix.test/v1/git/project-1.git?old=1',
        'feature/base',
        'a'.repeat(40),
      ),
    ).toBe(
      `https://api.kortix.test/v1/git/project-1.git/compiled-runtime?ref=feature%2Fbase&sha=${'a'.repeat(40)}`,
    )
  })

  test('downloads, verifies, and atomically installs server.mjs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-install-'))
    roots.push(root)
    const destination = join(root, 'server.mjs')
    const source = artifact()
    let authorization = ''
    const result = await installCompiledRuntime(config, {
      destination,
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization') || ''
        return response(source, { 'x-kortix-artifact-cache': 'hit' })
      },
    })

    expect(authorization).toBe('Bearer sandbox-token')
    expect(await readFile(destination, 'utf8')).toBe(source)
    expect(result).toEqual(
      expect.objectContaining({
        path: destination,
        bytes: Buffer.byteLength(source),
        cache: 'hit',
        sha256: createHash('sha256').update(source).digest('hex'),
      }),
    )
  })

  test('rejects a digest mismatch without installing the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-install-'))
    roots.push(root)
    const destination = join(root, 'server.mjs')

    await expect(
      installCompiledRuntime(config, {
        destination,
        fetchImpl: async () =>
          response(artifact(), { 'x-kortix-artifact-sha256': 'b'.repeat(64) }),
      }),
    ).rejects.toThrow('compiled runtime SHA-256 mismatch')
    await expect(readFile(destination)).rejects.toThrow()
  })

  test('rejects a runtime compiled for a different project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-install-'))
    roots.push(root)
    const destination = join(root, 'server.mjs')

    await expect(
      installCompiledRuntime(config, {
        destination,
        fetchImpl: async () => response(artifact({ project_id: 'project-2' })),
      }),
    ).rejects.toThrow('compiled runtime manifest does not match this session')
    await expect(readFile(destination)).rejects.toThrow()
  })

  test('rejects a runtime without executing it during manifest verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-runtime-install-'))
    roots.push(root)
    const destination = join(root, 'server.mjs')
    const executed = join(root, 'executed')
    const source = `${artifact()}\nawait Bun.write(${JSON.stringify(executed)}, "executed");\n`

    await installCompiledRuntime(config, {
      destination,
      fetchImpl: async () => response(source),
    })

    await expect(readFile(executed)).rejects.toThrow()
  })
})
