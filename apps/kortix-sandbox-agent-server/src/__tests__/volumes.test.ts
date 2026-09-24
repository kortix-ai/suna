import { describe, expect, test } from 'bun:test'
import { createProjectEnvStore } from '../project-env'
import {
  type MountableVolume,
  parseVolumesEnv,
  rcloneEnv,
  rcloneMountArgs,
  rcloneRemote,
  renderVolumesInstruction,
  startVolumes,
  type VolumeDeps,
  VOLUMES_INSTRUCTION_PATH,
} from '../volumes'

const DATA: MountableVolume = {
  name: 'data',
  mode: 'read-write',
  type: 's3',
  bucket: 'acme-data',
  prefix: 'training/',
  access_key_id_env: 'DATA_KEY_ID',
  secret_access_key_env: 'DATA_SECRET',
}

function envelope(volumes: unknown[]): string {
  return JSON.stringify({ version: 1, volumes })
}

describe('parseVolumesEnv', () => {
  test('keeps mountable and failed specs, drops malformed ones', () => {
    expect(
      parseVolumesEnv(
        envelope([
          DATA,
          { name: 'ghost', mode: 'read-only', error: 'not declared' },
          { name: 'BAD NAME', mode: 'read-only', type: 's3', bucket: 'b' },
          { name: 'nomode', type: 's3', bucket: 'b' },
          { name: 'data', mode: 'read-only', type: 's3', bucket: 'dup' },
          { name: 'half', mode: 'read-only', type: 's3' },
          { name: 'badenv', mode: 'read-only', type: 's3', bucket: 'b', access_key_id_env: 'not-an-env' },
        ]),
      ),
    ).toEqual([
      DATA,
      { name: 'ghost', mode: 'read-only', error: 'not declared' },
      { name: 'half', mode: 'read-only', error: 'the volume spec from the API is incomplete' },
      { name: 'badenv', mode: 'read-only', type: 's3', bucket: 'b' },
    ])
  })

  test('empty for absent, non-JSON, or unknown-version input', () => {
    expect(parseVolumesEnv(undefined)).toEqual([])
    expect(parseVolumesEnv('{nope')).toEqual([])
    expect(parseVolumesEnv(JSON.stringify({ version: 2, volumes: [DATA] }))).toEqual([])
  })
})

describe('rclone invocation', () => {
  test('remote narrows to the prefix', () => {
    expect(rcloneRemote(DATA)).toBe(':s3:acme-data/training')
    expect(rcloneRemote({ ...DATA, prefix: undefined })).toBe(':s3:acme-data')
  })

  test('credentials travel in env, never argv', () => {
    const env = rcloneEnv(DATA, { DATA_KEY_ID: 'AKIAEXAMPLE', DATA_SECRET: 's3cr3t' })
    expect(env).toEqual({
      env: {
        RCLONE_S3_PROVIDER: 'AWS',
        RCLONE_S3_ENV_AUTH: 'false',
        RCLONE_S3_NO_CHECK_BUCKET: 'true',
        RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        RCLONE_S3_SECRET_ACCESS_KEY: 's3cr3t',
      },
    })
    const args = rcloneMountArgs(DATA, { mountPoint: '/volumes/data', cacheDir: '/c', logFile: '/l', uid: 1000, gid: 1000 })
    expect(args.join(' ')).not.toContain('s3cr3t')
    expect(args.join(' ')).not.toContain('AKIAEXAMPLE')
  })

  test('an S3-compatible endpoint switches the provider; a public bucket sends no keys', () => {
    expect(rcloneEnv({ name: 'r2', mode: 'read-only', type: 's3', bucket: 'b', endpoint: 'https://x.r2.dev', region: 'auto' }, {})).toEqual({
      env: {
        RCLONE_S3_PROVIDER: 'Other',
        RCLONE_S3_ENV_AUTH: 'false',
        RCLONE_S3_NO_CHECK_BUCKET: 'true',
        RCLONE_S3_ENDPOINT: 'https://x.r2.dev',
        RCLONE_S3_REGION: 'auto',
      },
    })
  })

  test('an empty credential is an error, not an anonymous mount', () => {
    expect(rcloneEnv(DATA, { DATA_KEY_ID: 'AKIAEXAMPLE' })).toEqual({
      error: 'credential env var DATA_SECRET is empty in this session',
    })
  })

  test('mount flags keep the spike-verified settings', () => {
    const rw = rcloneMountArgs(DATA, { mountPoint: '/volumes/data', cacheDir: '/c/data', logFile: '/l/data.log', uid: 1000, gid: 1001 })
    expect(rw).toEqual([
      'mount', ':s3:acme-data/training', '/volumes/data',
      '--allow-other', '--uid', '1000', '--gid', '1001',
      '--use-server-modtime',
      '--vfs-cache-mode', 'full', '--vfs-cache-max-size', '2G', '--cache-dir', '/c/data',
      '--dir-cache-time', '1m', '--contimeout', '10s',
      '--log-file', '/l/data.log', '--log-level', 'INFO',
    ])
    // `--vfs-write-back 0s` corrupted edits on real S3; the default must stay.
    expect(rw).not.toContain('--vfs-write-back')
    expect(rcloneMountArgs({ ...DATA, mode: 'read-only' }, { mountPoint: 'm', cacheDir: 'c', logFile: 'l', uid: 0, gid: 0 })).toContain('--read-only')
  })
})

describe('renderVolumesInstruction', () => {
  test('lists every volume with its state and the object-storage limits', () => {
    const text = renderVolumesInstruction(
      [DATA, { name: 'r2', mode: 'read-only', type: 's3', bucket: 'b', endpoint: 'https://x.r2.dev' }, { name: 'ghost', mode: 'read-only', error: 'not declared' }],
      new Map([['data', { state: 'mounted' }]]),
    )
    expect(text).toContain('- `/volumes/data`: s3://acme-data/training/ (read-write).')
    expect(text).toContain('- `/volumes/r2`: s3://b at https://x.r2.dev (read-only), still mounting; retry in a few seconds.')
    expect(text).toContain('- `/volumes/ghost`: NOT MOUNTED. not declared')
    expect(text).toContain('about 5 seconds after the file is closed')
  })
})

/** A scripted sandbox: records every command and mount, never touches the host. */
function fakeDeps(opts: {
  uid?: number
  mounted?: Set<string>
  mountOnSpawn?: boolean
  spawnExit?: number
  listError?: Error
  log?: string
} = {}) {
  const mounted = opts.mounted ?? new Set<string>()
  const calls: Array<{ kind: 'run' | 'spawn'; cmd: string; args: string[]; env?: Record<string, string> }> = []
  const notes: string[] = []
  let clock = 0
  const deps: VolumeDeps = {
    run: async (cmd, args) => {
      calls.push({ kind: 'run', cmd, args })
    },
    spawnDetached: (cmd, args, env) => {
      calls.push({ kind: 'spawn', cmd, args, env })
      if (opts.mountOnSpawn) mounted.add(args[args.indexOf('mount') + 2]!)
      return { exited: opts.spawnExit === undefined ? new Promise(() => {}) : Promise.resolve(opts.spawnExit) }
    },
    isMounted: (path) => mounted.has(path),
    listDir: async () => {
      if (opts.listError) throw opts.listError
      return []
    },
    readLog: () => opts.log ?? '',
    writeInstruction: (path, text) => {
      expect(path).toBe(VOLUMES_INSTRUCTION_PATH)
      notes.push(text)
    },
    uid: opts.uid ?? 1000,
    gid: opts.uid ?? 1000,
    // A real timer at 1/100 speed: the 10 s budget still outlasts a 100 ms
    // poll, exactly as in production, and the fake clock advances with it.
    sleep: (ms) =>
      new Promise((resolve) =>
        setTimeout(() => {
          clock += ms
          resolve()
        }, ms / 100),
      ),
    now: () => clock,
  }
  return { deps, calls, notes, mounted }
}

function store(env: Record<string, string>) {
  return createProjectEnvStore({ ...env, KORTIX_PROJECT_SECRET_NAMES: Object.keys(env).join(',') })
}

describe('startVolumes', () => {
  test('no KORTIX_VOLUMES: nothing declared, nothing written', async () => {
    const { deps, calls, notes } = fakeDeps()
    const handle = startVolumes({ env: {}, projectEnv: store({}), deps })
    expect(handle.declared).toBe(false)
    await handle.ready
    expect(calls).toEqual([])
    expect(notes).toEqual([])
  })

  test('mounts through sudo with credentials from the project env store', async () => {
    const { deps, calls, notes } = fakeDeps({ mountOnSpawn: true })
    const handle = startVolumes({
      env: { KORTIX_VOLUMES: envelope([DATA]) },
      projectEnv: store({ DATA_KEY_ID: 'AKIAEXAMPLE', DATA_SECRET: 's3cr3t' }),
      deps,
    })
    // The note exists before any await: OpenCode's config composes right after.
    expect(notes[0]).toContain('still mounting')
    await handle.ready
    expect(calls[0]).toMatchObject({ kind: 'run', cmd: 'sudo', args: ['-n', 'mkdir', '-p', '/volumes/data', expect.stringContaining('/volumes/data'), '/var/log/kortix-volumes'] })
    expect(calls[1]!.cmd).toBe('sudo')
    expect(calls[1]!.args.slice(0, 4)).toEqual(['-n', '-E', 'rclone', 'mount'])
    expect(calls[1]!.env).toMatchObject({ RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE', RCLONE_S3_SECRET_ACCESS_KEY: 's3cr3t' })
    expect(notes.at(-1)).toContain('- `/volumes/data`: s3://acme-data/training/ (read-write).')
  })

  test('as root, rclone runs without sudo', async () => {
    const { deps, calls } = fakeDeps({ uid: 0, mountOnSpawn: true })
    await startVolumes({ env: { KORTIX_VOLUMES: envelope([{ ...DATA, access_key_id_env: undefined, secret_access_key_env: undefined }]) }, projectEnv: store({}), deps }).ready
    expect(calls.map((c) => c.cmd)).toEqual(['mkdir', 'rclone'])
  })

  test('an API-side error and a missing credential fail their volume only', async () => {
    const { deps, calls, notes } = fakeDeps({ mountOnSpawn: true })
    await startVolumes({
      env: { KORTIX_VOLUMES: envelope([{ name: 'ghost', mode: 'read-only', error: 'volume "ghost" is not declared' }, DATA]) },
      projectEnv: store({ DATA_KEY_ID: 'AKIAEXAMPLE' }),
      deps,
    }).ready
    expect(calls).toEqual([])
    expect(notes.at(-1)).toContain('- `/volumes/ghost`: NOT MOUNTED. volume "ghost" is not declared')
    expect(notes.at(-1)).toContain('- `/volumes/data`: NOT MOUNTED. credential env var DATA_SECRET is empty in this session')
  })

  test('an image without rclone reports how to fix it', async () => {
    const { deps, notes } = fakeDeps({ spawnExit: 127 })
    await startVolumes({ env: { KORTIX_VOLUMES: envelope([{ name: 'pub', mode: 'read-only', type: 's3', bucket: 'b' }]) }, projectEnv: store({}), deps }).ready
    expect(notes.at(-1)).toContain('NOT MOUNTED. rclone is not installed in this sandbox image; rebuild the sandbox template')
  })

  test('a rejected listing reports the S3 error rclone logged', async () => {
    const { deps, notes } = fakeDeps({
      mountOnSpawn: true,
      listError: new Error('EIO'),
      log: '2026/09/24 12:00:00 INFO  : mounted\n2026/09/24 12:00:01 ERROR : : error listing: operation error S3: ListObjectsV2, https response error StatusCode: 403, api error AccessDenied: Access Denied\n',
    })
    await startVolumes({ env: { KORTIX_VOLUMES: envelope([{ name: 'pub', mode: 'read-only', type: 's3', bucket: 'b' }]) }, projectEnv: store({}), deps }).ready
    expect(notes.at(-1)).toContain('NOT MOUNTED. : error listing: operation error S3: ListObjectsV2, https response error StatusCode: 403, api error AccessDenied: Access Denied')
  })

  test('a mount still up from an earlier daemon process is reused, not spawned again', async () => {
    const { deps, calls, notes } = fakeDeps({ mounted: new Set(['/volumes/pub']) })
    await startVolumes({ env: { KORTIX_VOLUMES: envelope([{ name: 'pub', mode: 'read-only', type: 's3', bucket: 'b' }]) }, projectEnv: store({}), deps }).ready
    expect(calls).toEqual([])
    expect(notes.at(-1)).toContain('- `/volumes/pub`: s3://b (read-only).')
  })

  test('ready stops waiting at the budget; the mount keeps its single rclone and fails at its own timeout', async () => {
    const { deps, calls, notes } = fakeDeps()
    await startVolumes({ env: { KORTIX_VOLUMES: envelope([{ name: 'slow', mode: 'read-only', type: 's3', bucket: 'b' }]) }, projectEnv: store({}), deps, budgetMs: 500 }).ready
    expect(notes.at(-1)).toContain('still mounting')
    // The fake clock runs the poll loop to its 60 s timeout in ~600 timer ticks.
    for (let i = 0; i < 200 && !notes.at(-1)!.includes('NOT MOUNTED'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(calls.filter((c) => c.kind === 'spawn')).toHaveLength(1)
    expect(notes.at(-1)).toContain('NOT MOUNTED. rclone did not mount within 60 s; see /var/log/kortix-volumes/slow.log')
  })
})
