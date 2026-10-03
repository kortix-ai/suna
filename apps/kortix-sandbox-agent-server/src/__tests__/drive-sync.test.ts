/**
 * Kortix Drive off Platinum: the daemon's drive sync, end to end through its
 * real HTTP client against a fake of the API's drive-sync routes on a real
 * port (helpers/fake-drive-sync-api.ts), with a temp dir standing in for
 * /drives. Each test names one sync rule and sets every other precondition.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmodSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriveSyncService } from '../drive-sync'
import { MountSync, conflictCopyName } from '../drive-sync/engine'
import { createHttpDriveSyncApi } from '../drive-sync/remote'
import { type FakeDriveSyncApi, startFakeDriveSyncApi } from './helpers/fake-drive-sync-api'

const DRIVE = 'aaaaaaaa-0000-0000-0000-000000000001'

let fake: FakeDriveSyncApi
let dir: string

beforeEach(() => {
  fake = startFakeDriveSyncApi()
  dir = mkdtempSync(join(tmpdir(), 'drive-sync-'))
})

afterEach(() => {
  fake.stop()
  rmSync(dir, { recursive: true, force: true })
})

function api() {
  return createHttpDriveSyncApi({ apiUrl: fake.url, projectId: fake.projectId, sessionId: fake.sessionId, token: fake.token })
}

function mount(opts: { readOnly?: boolean; subdir?: string; settleMs?: number } = {}) {
  fake.mounts = [{ driveId: DRIVE, name: 'My Drive', mountPath: '/drives/me', readOnly: !!opts.readOnly, ...(opts.subdir ? { subdir: opts.subdir } : {}) }]
  return new MountSync({
    remote: api().drive(DRIVE),
    localDir: join(dir, 'me'),
    remoteDir: opts.subdir ?? '/',
    readOnly: !!opts.readOnly,
    statePath: join(dir, 'state', 'me.json'),
    settleMs: opts.settleMs ?? 0,
  })
}

const local = (rel: string) => join(dir, 'me', rel)
const read = (rel: string) => readFileSync(local(rel), 'utf8')
/** A local edit with an mtime the manifest has not seen (same-ms writes would otherwise look unchanged). */
function edit(rel: string, content: string) {
  mkdirSync(join(local(rel), '..'), { recursive: true })
  writeFileSync(local(rel), content)
  const t = new Date(Date.now() - 5_000 + Math.floor(Math.random() * 1000))
  utimesSync(local(rel), t, t)
}
const writes = () => fake.calls.filter((c) => !c.startsWith('GET'))

describe('drive sync', () => {
  test('boot materializes the drive at the mount path, nested folders included', async () => {
    fake.write(DRIVE, '/notes/a.md', 'alpha')
    fake.write(DRIVE, '/b.txt', 'bravo')
    const sync = mount()
    const stats = await sync.cycle()
    expect(stats.pulled).toBe(2)
    expect(read('notes/a.md')).toBe('alpha')
    expect(read('b.txt')).toBe('bravo')
    expect(writes()).toEqual([])
    // A second pass with nothing changed does no file traffic.
    fake.calls.length = 0
    await sync.cycle()
    expect(fake.calls.filter((c) => c.includes('/files/content'))).toEqual([])
  })

  test('a local change is pushed, a drive change is pulled', async () => {
    fake.write(DRIVE, '/a.md', 'one')
    const sync = mount()
    await sync.cycle()
    edit('a.md', 'two')
    edit('new/c.md', 'created here')
    expect((await sync.cycle()).pushed).toBe(2)
    expect(fake.read(DRIVE, '/a.md')).toBe('two')
    expect(fake.read(DRIVE, '/new/c.md')).toBe('created here')

    fake.write(DRIVE, '/a.md', 'three, from the web app')
    expect((await sync.cycle()).pulled).toBe(1)
    expect(read('a.md')).toBe('three, from the web app')
  })

  test('a change on both sides keeps both: the drive keeps the name, this box’s version becomes the conflict copy', async () => {
    fake.write(DRIVE, '/report.md', 'base')
    const sync = mount()
    await sync.cycle()
    fake.write(DRIVE, '/report.md', 'theirs')
    edit('report.md', 'mine')
    const stats = await sync.cycle()
    expect(stats.conflicts).toBe(1)
    expect(read('report.md')).toBe('theirs')
    const copy = readdirSync(join(dir, 'me')).find((n) => n.startsWith('report (conflict '))!
    expect(copy).toMatch(/^report \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.md$/)
    expect(read(copy)).toBe('mine')
    expect(fake.read(DRIVE, `/${copy}`)).toBe('mine')
    expect(fake.read(DRIVE, '/report.md')).toBe('theirs')
    // Settled: nothing more moves.
    const again = await sync.cycle()
    expect(again.conflicts + again.pushed + again.pulled).toBe(0)
  })

  test('deletes follow both ways; a change wins over a delete', async () => {
    fake.write(DRIVE, '/x.md', 'x')
    fake.write(DRIVE, '/y.md', 'y')
    fake.write(DRIVE, '/z.md', 'z')
    const sync = mount()
    await sync.cycle()
    unlinkSync(local('x.md'))
    fake.remove(DRIVE, '/y.md')
    // z: deleted on the drive while changed here, so the change is kept.
    fake.remove(DRIVE, '/z.md')
    edit('z.md', 'z, edited')
    const stats = await sync.cycle()
    expect(stats.deletedRemote).toBe(1)
    expect(stats.deletedLocal).toBe(1)
    expect(fake.read(DRIVE, '/x.md')).toBeNull()
    expect(existsSync(local('y.md'))).toBe(false)
    expect(fake.read(DRIVE, '/z.md')).toBe('z, edited')
  })

  test('a rename here is a move on the drive, with no upload', async () => {
    fake.write(DRIVE, '/draft.md', 'the same bytes')
    const sync = mount()
    await sync.cycle()
    mkdirSync(local('final'), { recursive: true })
    renameSync(local('draft.md'), local('final/published.md'))
    fake.calls.length = 0
    const stats = await sync.cycle()
    expect(stats.moved).toBe(1)
    expect(fake.paths(DRIVE)).toEqual(['/final/published.md'])
    expect(writes()).toEqual(['POST /files/move'])
  })

  test('a read-only drive refuses every local change: nothing is sent, edits are put back', async () => {
    fake.write(DRIVE, '/policy.md', 'official')
    const sync = mount({ readOnly: true })
    await sync.cycle()
    expect(statSync(local('policy.md')).mode & 0o222).toBe(0)
    // The agent forces it anyway.
    chmodSync(local('policy.md'), 0o644)
    edit('policy.md', 'tampered')
    edit('extra.md', 'only here')
    unlinkSync(local('policy.md'))
    edit('policy.md', 'tampered again')
    const stats = await sync.cycle({ flush: true })
    expect(stats.refused).toBeGreaterThan(0)
    expect(writes()).toEqual([])
    expect(read('policy.md')).toBe('official')
    expect(fake.paths(DRIVE)).toEqual(['/policy.md'])
  })

  test('a folder mount syncs only its folder of the drive', async () => {
    fake.write(DRIVE, '/From agents/out.md', 'for you')
    fake.write(DRIVE, '/private.md', 'not in this mount')
    const sync = mount({ subdir: '/From agents' })
    await sync.cycle()
    expect(read('out.md')).toBe('for you')
    expect(existsSync(local('private.md'))).toBe(false)
    edit('reply.md', 'agent output')
    await sync.cycle()
    expect(fake.read(DRIVE, '/From agents/reply.md')).toBe('agent output')
  })

  test('a large file goes up in blocks, and only the blocks the drive lacks', async () => {
    const sync = mount()
    await sync.cycle()
    const big = new Uint8Array(9 * 1024 * 1024 + 5)
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251
    mkdirSync(join(dir, 'me'), { recursive: true })
    writeFileSync(local('big.bin'), big)
    await sync.cycle()
    expect(fake.read(DRIVE, '/big.bin')?.length).toBeGreaterThan(0)
    const sent = fake.calls.filter((c) => c.includes('/blocks')).length
    expect(sent).toBeGreaterThan(1)
    // The same bytes under a second name: the plan finds every block already stored.
    writeFileSync(local('copy.bin'), big)
    fake.calls.length = 0
    await sync.cycle()
    expect(fake.calls.filter((c) => c.includes('/blocks'))).toEqual([])
    expect(fake.paths(DRIVE)).toContain('/copy.bin')
  })

  test('conflict copies are named like Drive’s, after the original even for a copy of a copy', () => {
    const at = new Date(Date.UTC(2026, 9, 3, 14, 5))
    expect(conflictCopyName('notes.md', at)).toBe('notes (conflict 2026-10-03 1405).md')
    expect(conflictCopyName('notes (conflict 2026-10-01 0900).md', at, 2)).toBe('notes (conflict 2026-10-03 1405 2).md')
    expect(conflictCopyName('Makefile', at)).toBe('Makefile (conflict 2026-10-03 1405)')
  })
})

describe('drive sync service', () => {
  function service(settleMs: number) {
    return new DriveSyncService({ api: api(), root: dir, stateDir: join(dir, '.state'), settleMs })
  }

  test('the final push sends a change the loop was still waiting on', async () => {
    fake.mounts = [{ driveId: DRIVE, name: 'Agent', mountPath: '/drives/agent', readOnly: false }]
    const svc = service(60_000)
    expect(await svc.refreshMounts()).toBe(true)
    await svc.syncOnce()
    writeFileSync(join(dir, 'agent', 'last-words.md'), 'written just before stop')
    await svc.syncOnce()
    // Still settling: an ordinary pass leaves it for later.
    expect(fake.read(DRIVE, '/last-words.md')).toBeNull()
    expect((await svc.flush(10_000)).ok).toBe(true)
    expect(fake.read(DRIVE, '/last-words.md')).toBe('written just before stop')
  })

  test('waits for the boot to record the drives, writes the notes, and drops a drive that left the session', async () => {
    fake.ready = false
    const svc = service(0)
    expect(await svc.refreshMounts()).toBe(false)
    fake.ready = true
    fake.mounts = [{ driveId: DRIVE, name: 'Team', mountPath: '/drives/team', readOnly: false }]
    fake.write(DRIVE, '/doc.md', 'shared')
    expect(await svc.refreshMounts()).toBe(true)
    await svc.syncOnce()
    expect(readFileSync(join(dir, 'team', 'doc.md'), 'utf8')).toBe('shared')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(fake.notes)
    fake.mounts = []
    await svc.refreshMounts()
    expect(existsSync(join(dir, 'team'))).toBe(false)
  })
})

describe('drive sync in the daemon', () => {
  test('boots from the API’s env, materializes the drives, and pushes on the stop route', async () => {
    const { createHmac } = await import('node:crypto')
    const { createDriveSyncRouter, flushDriveSyncOnShutdown, startDriveSyncFromEnv } = await import('../drive-sync')
    const { KORTIX_USER_CONTEXT_HEADER } = await import('../kortix-user-context')
    fake.mounts = [{ driveId: DRIVE, name: 'Agent', mountPath: '/drives/agent', readOnly: false }]
    fake.write(DRIVE, '/brief.md', 'from the web app')
    const cfg = { apiUrl: fake.url, projectId: fake.projectId, sandboxToken: fake.token } as Parameters<typeof startDriveSyncFromEnv>[0]
    const env = {
      KORTIX_DRIVE_SYNC: '1',
      KORTIX_SESSION_ID: fake.sessionId,
      KORTIX_DRIVE_SYNC_ROOT: dir,
      KORTIX_RUNTIME_STATE_DIR: join(dir, '.runtime'),
    }
    expect(startDriveSyncFromEnv(cfg, { KORTIX_SESSION_ID: fake.sessionId })).toBeNull()
    try {
      expect(startDriveSyncFromEnv(cfg, env)).not.toBeNull()
      const brief = join(dir, 'agent', 'brief.md')
      for (let i = 0; i < 100 && !existsSync(brief); i++) await Bun.sleep(50)
      expect(readFileSync(brief, 'utf8')).toBe('from the web app')
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(fake.notes)

      writeFileSync(join(dir, 'agent', 'result.md'), 'done')
      const router = createDriveSyncRouter(cfg)
      expect((await router.request('/flush', { method: 'POST' })).status).toBe(401)
      const body = Buffer.from(
        JSON.stringify({ userId: 'system:stop', sandboxId: fake.sessionId, sandboxRole: 'platform_admin', scopes: ['*'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }),
      ).toString('base64url')
      const signed = `${body}.${createHmac('sha256', fake.token).update(body).digest('base64url')}`
      const res = await router.request('/flush', { method: 'POST', headers: { [KORTIX_USER_CONTEXT_HEADER]: signed } })
      expect(await res.json()).toEqual({ ok: true, syncing: true })
      expect(fake.read(DRIVE, '/result.md')).toBe('done')
    } finally {
      await flushDriveSyncOnShutdown(5_000)
    }
  })
})

describe('drive sync data safety', () => {
  test('a drive write landing between the check and the upload is refused, and both versions are kept', async () => {
    fake.write(DRIVE, '/plan.md', 'base')
    const sync = mount()
    await sync.cycle()
    edit('plan.md', 'mine')
    // Another writer lands after the box checked the drive's version, before its write.
    fake.beforeWrite = (driveId, path) => {
      if (path !== '/plan.md') return
      fake.beforeWrite = null
      fake.write(driveId, path, 'theirs, landed mid-push')
    }
    const stats = await sync.cycle()
    expect(stats.conflicts).toBe(1)
    expect(fake.read(DRIVE, '/plan.md')).toBe('theirs, landed mid-push')
    expect(read('plan.md')).toBe('theirs, landed mid-push')
    const copy = fake.paths(DRIVE).find((p) => p.startsWith('/plan (conflict '))!
    expect(fake.read(DRIVE, copy)).toBe('mine')
  })

  test('the same race on a block upload is refused at commit, and both versions are kept', async () => {
    const big = new Uint8Array(9 * 1024 * 1024).fill(7)
    fake.write(DRIVE, '/big.bin', big)
    const sync = mount()
    await sync.cycle()
    const mine = new Uint8Array(9 * 1024 * 1024).fill(8)
    writeFileSync(local('big.bin'), mine)
    fake.beforeWrite = (driveId, path) => {
      if (path !== '/big.bin') return
      fake.beforeWrite = null
      fake.write(driveId, path, 'theirs')
    }
    expect((await sync.cycle()).conflicts).toBe(1)
    expect(fake.read(DRIVE, '/big.bin')).toBe('theirs')
    expect(fake.paths(DRIVE).some((p) => p.startsWith('/big (conflict '))).toBe(true)
  })

  function service(settleMs: number) {
    return new DriveSyncService({ api: api(), root: dir, stateDir: join(dir, '.state'), settleMs })
  }

  test('a drive leaving the session with unsent changes is kept aside, never deleted, and the notes say where', async () => {
    fake.mounts = [{ driveId: DRIVE, name: 'Team', mountPath: '/drives/team', readOnly: false }]
    fake.write(DRIVE, '/doc.md', 'shared')
    const svc = service(60_000)
    await svc.refreshMounts()
    await svc.syncOnce()
    writeFileSync(join(dir, 'team', 'draft.md'), 'not sent yet')
    // Detached: the API no longer lets this box write the drive.
    fake.mounts = []
    await svc.refreshMounts()
    expect(existsSync(join(dir, 'team'))).toBe(false)
    const [kept] = readdirSync(join(dir, '.detached'))
    expect(kept).toMatch(/^team-\d{8}-\d{6}$/)
    expect(readFileSync(join(dir, '.detached', kept!, 'draft.md'), 'utf8')).toBe('not sent yet')
    expect(fake.read(DRIVE, '/draft.md')).toBeNull()
    const notes = readFileSync(join(dir, 'README.md'), 'utf8')
    expect(notes).toContain('/drives/team (Team) left this session with 1 change(s)')
    expect(notes).toContain(`/drives/.detached/${kept}`)
  })

  test('the API’s pre-detach push of one drive sends its changes, so the detach then deletes nothing unsent', async () => {
    const OTHER = 'aaaaaaaa-0000-0000-0000-000000000002'
    fake.mounts = [
      { driveId: DRIVE, name: 'Team', mountPath: '/drives/team', readOnly: false },
      { driveId: OTHER, name: 'Agent', mountPath: '/drives/agent', readOnly: false },
    ]
    const svc = service(60_000)
    await svc.refreshMounts()
    await svc.syncOnce()
    writeFileSync(join(dir, 'team', 'a.md'), 'team change')
    writeFileSync(join(dir, 'agent', 'b.md'), 'agent change')
    expect((await svc.flush(10_000, DRIVE)).ok).toBe(true)
    expect(fake.read(DRIVE, '/a.md')).toBe('team change')
    expect(fake.read(OTHER, '/b.md')).toBeNull()
    fake.mounts = fake.mounts.filter((m) => m.driveId !== DRIVE)
    await svc.refreshMounts()
    expect(existsSync(join(dir, 'team'))).toBe(false)
    expect(existsSync(join(dir, '.detached'))).toBe(false)
  })

  test('a drive turning read-only keeps a copy of unsent edits before they are put back', async () => {
    fake.mounts = [{ driveId: DRIVE, name: 'Team', mountPath: '/drives/team', readOnly: false }]
    fake.write(DRIVE, '/doc.md', 'official')
    const svc = service(60_000)
    await svc.refreshMounts()
    await svc.syncOnce()
    writeFileSync(join(dir, 'team', 'doc.md'), 'my unsent edit')
    fake.mounts = [{ ...fake.mounts[0]!, readOnly: true }]
    await svc.refreshMounts()
    await svc.syncOnce()
    const [kept] = readdirSync(join(dir, '.detached'))
    expect(readFileSync(join(dir, '.detached', kept!, 'doc.md'), 'utf8')).toBe('my unsent edit')
    expect(readFileSync(join(dir, 'team', 'doc.md'), 'utf8')).toBe('official')
    expect(fake.read(DRIVE, '/doc.md')).toBe('official')
  })

  test('without a writable /drives (no passwordless sudo) the drives sync into the fallback folder', async () => {
    const { resolveDriveSyncRoot } = await import('../drive-sync')
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      expect(resolveDriveSyncRoot(join(locked, 'drives'), join(dir, 'home', 'drives'))).toBe(join(dir, 'home', 'drives'))
      expect(existsSync(join(dir, 'home', 'drives'))).toBe(true)
      expect(resolveDriveSyncRoot(join(dir, 'ok'), join(dir, 'unused'))).toBe(join(dir, 'ok'))
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})
