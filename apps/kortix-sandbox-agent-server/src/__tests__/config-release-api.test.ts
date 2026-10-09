/**
 * The config release API client: descriptor request, strict descriptor
 * validation, and the archive download (one redirect, no bearer to storage,
 * size cap). Real archives from a real repository; a fake API over HTTP.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigReleaseApiError,
  downloadConfigArchive,
  fetchConfigReleaseDescriptor,
    type ConfigReleaseApi,
} from '@/services/config-release/api-client'
import { MAX_CONFIG_ARCHIVE_BYTES, parseConfigReleaseDescriptor } from '@/services/config-release/descriptor'
import {
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  resetSessionTokenHealthForTests,
  sessionTokenPresumedDead,
} from '@/lib/kortix-api/session-token-health'
import {
  buildRelease,
  commitAll,
  initRepo,
  serveRelease,
  startFakeApi,
  write,
  type BuiltRelease,
  type FakeApi,
} from './helpers/config-release-fixtures'

let root: string
let api: FakeApi
let release: BuiltRelease
let client: ConfigReleaseApi

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-release-api-'))
  const repo = join(root, 'repo')
  initRepo(repo)
  write(repo, '.kortix/opencode/opencode.jsonc', '{}\n')
  write(repo, '.kortix/opencode/agents/kortix.md', 'PROMPT\n')
  const commit = commitAll(repo, 'base')
  release = buildRelease(repo, commit, '.kortix/opencode', { governance: '{"agent":{}}' })
  api = startFakeApi('tok')
  client = { apiUrl: api.url, projectId: 'proj-1', sessionId: 'ses-1', token: 'tok' }
})

afterAll(() => {
  api.stop()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  resetSessionTokenHealthForTests()
})

afterEach(() => {
  resetSessionTokenHealthForTests()
})

describe('fetchConfigReleaseDescriptor', () => {
  test('asks for v3 with the sandbox bearer and returns the validated descriptor', async () => {
    // The request has no inputs that pick the release: the desired release is
    // always the base branch's current one. The body only asks for v3.
    serveRelease(api, release)
    const descriptor = await fetchConfigReleaseDescriptor(client)
    expect(descriptor).toEqual(release.descriptor)
    const last = api.descriptorRequests.at(-1)!
    expect(last.path).toBe('/v1/projects/proj-1/sessions/ses-1/config-release')
    expect(last.authorization).toBe('Bearer tok')
    expect(last.body).toEqual({ accept: ['config-release-v3'] })
  })

  test('accepts an API URL without the /v1 suffix', async () => {
    serveRelease(api, release)
    const descriptor = await fetchConfigReleaseDescriptor({ ...client, apiUrl: api.url.replace(/\/v1$/, '') })
    expect(descriptor.release_id).toBe(release.descriptor.release_id)
  })

  test('an API that predates the spec answers 404; the error carries the status', async () => {
    api.respond({ status: 404, json: { error: 'not found' } })
    const err = await fetchConfigReleaseDescriptor(client).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigReleaseApiError)
    expect(err.status).toBe(404)
  })

  test('an unreachable API is a network error with a null status', async () => {
    const err = await fetchConfigReleaseDescriptor({ ...client, apiUrl: 'http://127.0.0.1:1/v1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigReleaseApiError)
    expect(err.status).toBeNull()
  })

  test('a malformed descriptor is refused before any field is used', async () => {
    api.respond({ status: 200, json: { ...release.descriptor, release_id: 'not-hex' } })
    await expect(fetchConfigReleaseDescriptor(client)).rejects.toThrow(/release_id/)
  })

  test('a dead-session-token 401 reports to the shared breaker, and a 2xx clears it', async () => {
    // KRTX-613: this client is the daemon's config-release path. It must feed
    // the one signal built for `401 Session token is not active`, so the
    // runtime-truth tick can stop re-issuing a request the API can never accept.
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
      api.respond({ status: 401, json: { error: true, message: 'Session token is not active', status: 401 } })
      await fetchConfigReleaseDescriptor(client).catch(() => {})
    }
    expect(sessionTokenPresumedDead()).toBe(true)

    // A rotated credential answers again; the same response type clears it.
    serveRelease(api, release)
    await fetchConfigReleaseDescriptor(client)
    expect(sessionTokenPresumedDead()).toBe(false)
  })
})

describe('parseConfigReleaseDescriptor', () => {
  const valid = () => structuredClone(release.descriptor)

  test('refuses a file path that climbs out of the config dir', () => {
    const d = valid()
    d.files![0]![0] = '../escape.md'
    expect(() => parseConfigReleaseDescriptor(d)).toThrow(/plain relative path/)
  })

  test('refuses an absolute file path and a duplicate file', () => {
    const abs = valid()
    abs.files![0]![0] = '/etc/passwd'
    expect(() => parseConfigReleaseDescriptor(abs)).toThrow()
    const dup = valid()
    dup.files!.push([...dup.files![0]!] as never)
    expect(() => parseConfigReleaseDescriptor(dup)).toThrow(/duplicate/)
  })

  test('refuses an archive URL outside the API archive route', () => {
    for (const url of ['https://evil.example/a.tgz', '//evil.example/v1/projects/p/config-archives/ab', '/v1/sessions/x']) {
      const d = valid()
      d.archive!.url = url
      expect(() => parseConfigReleaseDescriptor(d)).toThrow(/archive.url/)
    }
  })

  test('refuses an archive larger than the cap and a non-literal config dir', () => {
    const big = valid()
    big.archive!.bytes = MAX_CONFIG_ARCHIVE_BYTES + 1
    expect(() => parseConfigReleaseDescriptor(big)).toThrow()
    const magic = valid()
    magic.config_dir = ':(top)*'
    expect(() => parseConfigReleaseDescriptor(magic)).toThrow(/config_dir/)
  })

  test('follow-base is the only mode; repository-less sessions get governance only', () => {
    // A session that edited its own config dir still receives the base
    // release. Any other mode is refused outright.
    expect(parseConfigReleaseDescriptor(valid()).mode).toBe('follow-base')
    expect(() => parseConfigReleaseDescriptor({ ...valid(), mode: 'session-files', archive: null, files: null })).toThrow(
      /mode/,
    )
    const withheld = { ...valid(), archive: null, files: null, reason: 'repository access withheld' }
    expect(parseConfigReleaseDescriptor(withheld).compiled_governance).toBe('{"agent":{}}')
  })

  test('governance and its etag are both set or both null', () => {
    expect(() => parseConfigReleaseDescriptor({ ...valid(), compiled_governance_etag: null })).toThrow(/both/)
  })

  // v3: a tree over the API's archive cap keeps its release and has no
  // archive. A v2 daemon read `archive: null` as governance only, so v2 keeps
  // refusing that shape.
  test('a v3 tree release may have no archive; a v2 one may not', () => {
    const snapshot = { url: 'https://bucket.example/o/r.tree.tar.gz?X-Amz-Signature=s', sha256: 'a'.repeat(64), bytes: 40 << 20, entries: 9, expires_at: '2026-10-08T12:00:00Z' }
    const v3 = parseConfigReleaseDescriptor({ ...valid(), format: 'config-release-v3', archive: null, snapshot })
    expect(v3.files).toEqual(release.descriptor.files)
    expect(v3.snapshot).toEqual(snapshot)
    expect(parseConfigReleaseDescriptor({ ...valid(), format: 'config-release-v3', archive: null }).snapshot).toBeNull()
    expect(() => parseConfigReleaseDescriptor({ ...valid(), archive: null })).toThrow(/v2 tree release needs its archive/)
  })

  test('refuses a snapshot without files, files without a release, and a snapshot URL that is not http(s)', () => {
    const snapshot = { url: 'https://bucket.example/x', sha256: 'a'.repeat(64), bytes: 1, entries: 1, expires_at: 'x' }
    const v3 = { ...valid(), format: 'config-release-v3' }
    expect(() => parseConfigReleaseDescriptor({ ...v3, archive: null, files: null, snapshot })).toThrow(/snapshot needs its files/)
    expect(() => parseConfigReleaseDescriptor({ ...v3, archive: null, release_id: null })).toThrow(/files need a release_id/)
    expect(() => parseConfigReleaseDescriptor({ ...v3, snapshot: { ...snapshot, url: 'file:///etc/passwd' } })).toThrow(/snapshot.url/)
  })
})

describe('downloadConfigArchive', () => {
  test('streams the archive from the API with the bearer', async () => {
    serveRelease(api, release)
    api.redirectToStorage = false
    const body = await downloadConfigArchive(client, release.descriptor.archive!.url, {
      expectedBytes: release.descriptor.archive!.bytes,
    })
    expect(body.equals(release.archive)).toBe(true)
    expect(api.archiveRequests.at(-1)!.authorization).toBe('Bearer tok')
  })

  test('follows one redirect to storage and sends it no Authorization header', async () => {
    serveRelease(api, release)
    api.redirectToStorage = true
    const before = api.storageRequests.length
    const body = await downloadConfigArchive(client, release.descriptor.archive!.url)
    api.redirectToStorage = false
    expect(body.equals(release.archive)).toBe(true)
    expect(api.storageRequests.length).toBe(before + 1)
    expect(api.storageRequests.at(-1)!.authorization).toBeNull()
    expect(api.archiveRequests.at(-1)!.authorization).toBe('Bearer tok')
  })

  test('refuses a second redirect', async () => {
    const hops = Bun.serve({
      port: 0,
      fetch: (req) =>
        new Response(null, { status: 302, headers: { location: new URL('/again', req.url).toString() } }),
    })
    try {
      const err = await downloadConfigArchive(
        { ...client, apiUrl: `http://127.0.0.1:${hops.port}/v1` },
        '/v1/projects/proj-1/config-archives/abc',
      ).catch((e) => e)
      expect(String(err)).toMatch(/more than once/)
    } finally {
      hops.stop(true)
    }
  })

  test('refuses a body over the cap while it streams', async () => {
    const big = Bun.serve({
      port: 0,
      // Streamed without Content-Length, so only the running count can stop it.
      fetch: () => {
        let sent = 0
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent++ >= 64) return controller.close()
              controller.enqueue(new Uint8Array(64 * 1024))
            },
          }),
        )
      },
    })
    try {
      const err = await downloadConfigArchive(
        { ...client, apiUrl: `http://127.0.0.1:${big.port}` },
        '/v1/projects/proj-1/config-archives/abc',
        { maxBytes: 256 * 1024 },
      ).catch((e) => e)
      expect(String(err)).toMatch(/exceeds the limit of 262144 bytes/)
    } finally {
      big.stop(true)
    }
  })

  test('refuses a size that differs from the descriptor', async () => {
    serveRelease(api, release)
    await expect(
      downloadConfigArchive(client, release.descriptor.archive!.url, { expectedBytes: release.archive.length + 1 }),
    ).rejects.toThrow(/the descriptor says/)
  })

  test('the archive is byte-deterministic for one tree', () => {
    const repo = join(root, 'repo')
    const again = buildRelease(repo, release.descriptor.source_commit!, '.kortix/opencode', { governance: '{"agent":{}}' })
    expect(again.archive.equals(release.archive)).toBe(true)
    expect(spawnSync('git', ['--version']).status).toBe(0)
  })
})

describe('error codes', () => {
  test('an unknown conflict carries its status, code and error text; nothing special-cases 409', async () => {
    api.respond({ status: 409, json: { error: 'other', code: 'other_conflict' } })
    const other = await fetchConfigReleaseDescriptor(client).catch((e) => e)
    expect(other.status).toBe(409)
    expect(other.code).toBe('other_conflict')
    expect(other.message).toMatch(/descriptor request answered 409/)
  })
})
