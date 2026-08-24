import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Config } from '../config'
import { createOpencodeSupervisor, prefetchExecutablePages } from '../opencode'

const tempDirs: string[] = []

async function fixtureFile(size: number): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-opencode-prefetch-'))
  const path = join(dir, 'opencode')
  tempDirs.push(dir)
  await writeFile(path, Buffer.alloc(size, 0x5a))
  return { dir, path }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('OpenCode executable prefetch', () => {
  test('reads the complete executable with bounded buffers', async () => {
    const size = 4 * 1024 * 1024 + 17
    const fixture = await fixtureFile(size)

    expect(await prefetchExecutablePages(fixture.path)).toBe(size)
  })

  test('rejects before opening when the caller already stopped', async () => {
    const fixture = await fixtureFile(1024)
    const controller = new AbortController()
    controller.abort()

    await expect(prefetchExecutablePages(fixture.path, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('does not open the executable when buffer allocation fails', async () => {
    const missing = join(tmpdir(), 'kortix-opencode-prefetch-missing-buffer-target')

    await expect(
      prefetchExecutablePages(missing, undefined, () => {
        throw new Error('synthetic allocation failure')
      }),
    ).rejects.toThrow('synthetic allocation failure')
  })

  test('resolves and prefetches the binary once per supervisor', async () => {
    const fixture = await fixtureFile(1024)
    const marks: string[] = []
    const cfg = {
      workspace: fixture.dir,
      projectTarget: fixture.dir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as Config
    const opencode = createOpencodeSupervisor(cfg, fixture.dir, undefined, {
      binaryPathOverride: fixture.path,
      onStartupMark: (mark) => marks.push(mark),
    })

    expect(await opencode.prefetchBinary()).toBe(true)
    expect(await opencode.prefetchBinary()).toBe(true)
    expect(opencode.getBinaryPath()).toBe(fixture.path)
    expect(marks.filter((mark) => mark === 'runtime-binary-resolved')).toHaveLength(1)
    expect(marks.filter((mark) => mark === 'runtime-binary-prefetch-started')).toHaveLength(1)
    expect(marks.filter((mark) => mark === 'runtime-binary-prefetched')).toHaveLength(1)
  })

  test('keeps a read failure on the fallback path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-opencode-prefetch-missing-'))
    tempDirs.push(dir)
    const missing = join(dir, 'missing-opencode')
    const cfg = {
      workspace: dir,
      projectTarget: dir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as Config
    const marks: string[] = []
    const opencode = createOpencodeSupervisor(cfg, dir, undefined, {
      binaryPathOverride: missing,
      onStartupMark: (mark) => marks.push(mark),
    })

    expect(await opencode.prefetchBinary()).toBe(false)
    expect(marks).toContain('runtime-binary-prefetch-failed')
  })

  test('a failed prefetch does not prevent the resolved executable from starting', async () => {
    const fixture = await fixtureFile(1024)
    await writeFile(
      fixture.path,
      '#!/usr/bin/env bash\ntrap \'exit 0\' TERM INT\nwhile :; do /bin/sleep 0.05; done\n',
    )
    await chmod(fixture.path, 0o755)
    const cfg = {
      workspace: fixture.dir,
      projectTarget: fixture.dir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as Config
    const opencode = createOpencodeSupervisor(cfg, fixture.dir, undefined, {
      binaryPathOverride: fixture.path,
      configPathOverride: join(fixture.dir, 'opencode-config.json'),
      prefetchExecutableOverride: async () => {
        throw new Error('synthetic read failure')
      },
    })

    expect(await opencode.prefetchBinary()).toBe(false)
    await opencode.start()
    expect(opencode.getPid()).not.toBeNull()
    await opencode.stop()
  })

  test('stop aborts and joins an active prefetch', async () => {
    const fixture = await fixtureFile(1024)
    let observedSignal: AbortSignal | undefined
    let announceStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    const cfg = {
      workspace: fixture.dir,
      projectTarget: fixture.dir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as Config
    const opencode = createOpencodeSupervisor(cfg, fixture.dir, undefined, {
      binaryPathOverride: fixture.path,
      prefetchExecutableOverride: (_path, signal) =>
        new Promise<number>((_resolve, reject) => {
          observedSignal = signal
          announceStarted?.()
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('prefetch stopped', 'AbortError')),
            { once: true },
          )
        }),
    })

    const prefetch = opencode.prefetchBinary()
    await started
    await opencode.stop()

    expect(observedSignal?.aborted).toBe(true)
    expect(await prefetch).toBe(false)
  })

  test('cancel stops prefetch without delaying spawn', async () => {
    const fixture = await fixtureFile(1024)
    await writeFile(
      fixture.path,
      '#!/usr/bin/env bash\ntrap \'exit 0\' TERM INT\nwhile :; do /bin/sleep 0.05; done\n',
    )
    await chmod(fixture.path, 0o755)
    let releasePrefetch: (() => void) | undefined
    let announceStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    const marks: string[] = []
    const cfg = {
      workspace: fixture.dir,
      projectTarget: fixture.dir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as Config
    const opencode = createOpencodeSupervisor(cfg, fixture.dir, undefined, {
      binaryPathOverride: fixture.path,
      configPathOverride: join(fixture.dir, 'opencode-config.json'),
      onStartupMark: (mark) => marks.push(mark),
      prefetchExecutableOverride: (_path, _signal) =>
        new Promise<number>((resolve) => {
          releasePrefetch = () => resolve(1024)
          announceStarted?.()
        }),
    })

    const prefetch = opencode.prefetchBinary()
    await started
    opencode.cancelBinaryPrefetch()
    await opencode.start()

    expect(opencode.getPid()).not.toBeNull()
    releasePrefetch?.()
    expect(await prefetch).toBe(false)
    expect(marks).toContain('runtime-binary-prefetch-cancelled')
    await opencode.stop()
  })

  test('retries a transient binary lookup miss on the next start', async () => {
    const fixture = await fixtureFile(1024)
    await writeFile(
      fixture.path,
      '#!/usr/bin/env bash\ntrap \'exit 0\' TERM INT\nwhile :; do /bin/sleep 0.05; done\n',
    )
    await chmod(fixture.path, 0o755)
    let attempts = 0
    const cfg = {
      workspace: fixture.dir,
      projectTarget: fixture.dir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as Config
    const opencode = createOpencodeSupervisor(cfg, fixture.dir, undefined, {
      configPathOverride: join(fixture.dir, 'opencode-config.json'),
      binaryPathResolverOverride: async () => (++attempts === 1 ? null : fixture.path),
    })

    await opencode.start()
    expect(opencode.getPid()).toBeNull()
    await opencode.start()
    expect(opencode.getPid()).not.toBeNull()
    expect(attempts).toBe(2)
    await opencode.stop()
  })

  test('overlaps prefetch with repository work and cancels it before spawn', async () => {
    const main = await readFile(resolve(import.meta.dir, '..', 'main.ts'), 'utf8')
    const begin = main.indexOf('const opencodeBinaryPrefetchPromise')
    const repo = main.indexOf('const repoMaterializePromise')
    const repoErrorBranch = main.indexOf('if (bootState.repoMaterializationError)')
    const cancelPrefetch = main.indexOf('opencode.cancelBinaryPrefetch()')
    const spawn = main.indexOf('await opencode.start()')

    expect(begin).toBeGreaterThan(-1)
    expect(begin).toBeLessThan(repo)
    expect(cancelPrefetch).toBeGreaterThan(repo)
    expect(cancelPrefetch).toBeLessThan(repoErrorBranch)
    expect(cancelPrefetch).toBeLessThan(spawn)
    expect(main).not.toContain('await opencodeBinaryPrefetchPromise')
  })
})
