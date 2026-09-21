/**
 * Real Git repositories, real archives and a fake API for the config release
 * tests. The archive build follows the spec's release builder: the config tree
 * is wrapped in a commit with fixed dates, archived as tar, and gzipped with
 * `gzip -n`. Nothing here mocks Git.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigReleaseDescriptor, ConfigReleaseFile } from '../../config-release/descriptor'

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

export function write(repo: string, rel: string, body: string): void {
  mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(repo, rel), body)
}

export function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', message)
  return git(repo, 'rev-parse', 'HEAD')
}

export function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--initial-branch=main', '--quiet')
  git(dir, 'config', 'user.email', 't@t.co')
  git(dir, 'config', 'user.name', 'T')
}

export function governanceEtag(governance: string | null): string | null {
  return governance ? createHash('sha256').update(governance).digest('hex').slice(0, 16) : null
}

export interface BuiltRelease {
  descriptor: ConfigReleaseDescriptor
  archive: Buffer
}

/** The API's release builder, run against a real repository. */
export function buildRelease(
  repo: string,
  commit: string,
  configDir: string,
  opts: { projectId?: string; governance?: string | null; mode?: 'follow-base' | 'session-files' } = {},
): BuiltRelease {
  const tree = git(repo, 'rev-parse', `${commit}:${configDir}`)
  const listed = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '-z', tree], { encoding: 'buffer' })
  const files: ConfigReleaseFile[] = []
  for (const row of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t')
    const [mode, type, blob] = row.slice(0, tab).split(' ')
    if (type === 'blob') files.push([row.slice(tab + 1), mode as ConfigReleaseFile[1], blob!])
  }
  const wrapped = spawnSync('git', ['-C', repo, 'commit-tree', tree, '-m', 'config'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' },
  }).stdout.trim()
  const tar = spawnSync('git', ['-C', repo, 'archive', '--format=tar', wrapped], { encoding: 'buffer' }).stdout
  const archive = spawnSync('gzip', ['-n'], { input: tar, encoding: 'buffer' }).stdout
  const governance = opts.governance === undefined ? null : opts.governance
  const etag = governanceEtag(governance)
  const projectId = opts.projectId ?? 'proj-1'
  const mode = opts.mode ?? 'follow-base'
  const descriptor: ConfigReleaseDescriptor = {
    format: 'config-release-v1',
    release_id: createHash('sha256').update(`${tree}:${etag ?? ''}`).digest('hex'),
    mode,
    source_commit: commit,
    config_dir: configDir,
    config_tree_id: tree,
    archive: mode === 'follow-base' ? { url: `/v1/projects/${projectId}/config-archives/${tree}`, bytes: archive.length } : null,
    files: mode === 'follow-base' ? files : null,
    compiled_governance: governance,
    compiled_governance_etag: etag,
    reason: null,
  }
  return { descriptor, archive }
}

export interface FakeApi {
  url: string
  /** Every descriptor request: its body and Authorization header. */
  descriptorRequests: Array<{ body: unknown; authorization: string | null; path: string }>
  archiveRequests: Array<{ authorization: string | null; path: string }>
  storageRequests: Array<{ authorization: string | null; path: string }>
  /** What the next descriptor request answers. */
  respond: (next: { status?: number; json?: unknown }) => void
  /** Archives by config tree ID. */
  archives: Map<string, Buffer>
  /** Serve archives by `302` to the storage server instead of streaming them. */
  redirectToStorage: boolean
  /** Answer every archive request with this instead of the bytes. */
  archiveOverride: { status: number; json: unknown } | null
  stop: () => void
}

export function startFakeApi(token = 'sandbox-token'): FakeApi {
  let next: { status?: number; json?: unknown } = { status: 404, json: { error: 'no descriptor' } }
  const state = {
    descriptorRequests: [] as FakeApi['descriptorRequests'],
    archiveRequests: [] as FakeApi['archiveRequests'],
    storageRequests: [] as FakeApi['storageRequests'],
    archives: new Map<string, Buffer>(),
    redirectToStorage: false,
    archiveOverride: null as { status: number; json: unknown } | null,
  }
  const storage = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      state.storageRequests.push({ authorization: req.headers.get('authorization'), path: url.pathname })
      const tree = url.pathname.split('/').pop()!
      const body = state.archives.get(tree)
      return body ? new Response(body) : new Response('missing', { status: 404 })
    },
  })
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const authorization = req.headers.get('authorization')
      if (req.method === 'POST' && url.pathname.endsWith('/config-release')) {
        state.descriptorRequests.push({ body: await req.json().catch(() => null), authorization, path: url.pathname })
        if (authorization !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
        return Response.json(next.json ?? null, { status: next.status ?? 200 })
      }
      const archive = /^\/v1\/projects\/[^/]+\/config-archives\/([0-9a-f]+)$/.exec(url.pathname)
      if (req.method === 'GET' && archive) {
        state.archiveRequests.push({ authorization, path: url.pathname })
        if (authorization !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 })
        if (state.archiveOverride) return Response.json(state.archiveOverride.json, { status: state.archiveOverride.status })
        if (state.redirectToStorage) {
          return new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${storage.port}/signed/${archive[1]}?token=signed` },
          })
        }
        const body = state.archives.get(archive[1]!)
        return body ? new Response(body) : new Response('missing', { status: 404 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${api.port}/v1`,
    get descriptorRequests() {
      return state.descriptorRequests
    },
    get archiveRequests() {
      return state.archiveRequests
    },
    get storageRequests() {
      return state.storageRequests
    },
    respond: (value) => {
      next = value
    },
    archives: state.archives,
    get redirectToStorage() {
      return state.redirectToStorage
    },
    set redirectToStorage(value: boolean) {
      state.redirectToStorage = value
    },
    get archiveOverride() {
      return state.archiveOverride
    },
    set archiveOverride(value: { status: number; json: unknown } | null) {
      state.archiveOverride = value
    },
    stop: () => {
      api.stop(true)
      storage.stop(true)
    },
  }
}

/** The API's answer for a session from a previous repository generation. */
export const REPOSITORY_CHANGED = {
  status: 409,
  json: { error: 'Session belongs to a previous repository', code: 'session_repository_changed' },
}

/** Serve `release` from the fake API. */
export function serveRelease(api: FakeApi, release: BuiltRelease): void {
  if (release.descriptor.config_tree_id) api.archives.set(release.descriptor.config_tree_id, release.archive)
  api.respond({ status: 200, json: release.descriptor })
}
