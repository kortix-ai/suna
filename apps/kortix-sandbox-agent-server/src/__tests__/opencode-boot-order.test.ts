import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { createOpencodeLifecycle } from '../harness/open-code/lifecycle'

const tempDirs: string[] = []

async function fixtureFile(size: number): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-opencode-boot-'))
  const path = join(dir, 'opencode')
  tempDirs.push(dir)
  await writeFile(path, Buffer.alloc(size, 0x5a))
  return { dir, path }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('OpenCode lifecycle boot', () => {
  test('compiled boot disables the redundant remote model catalog fetch', async () => {
    const fixture = await fixtureFile(1024)
    const capturePath = join(fixture.dir, 'models-fetch.txt')
    await writeFile(
      fixture.path,
      '#!/usr/bin/env bash\nprintf "%s" "$OPENCODE_DISABLE_MODELS_FETCH" > "$CAPTURE_PATH"\ntrap \'exit 0\' TERM INT\nwhile :; do /bin/sleep 0.05; done\n',
    )
    await chmod(fixture.path, 0o755)
    const previousFormat = process.env.KORTIX_COMPILED_RUNTIME_FORMAT
    const previousCapture = process.env.CAPTURE_PATH
    process.env.KORTIX_COMPILED_RUNTIME_FORMAT = 'kortix.compiled-runtime.v1'
    process.env.CAPTURE_PATH = capturePath
    const cfg = {
      workspace: fixture.dir,
      projectTarget: fixture.dir,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
    } as Config
    const opencode = createOpencodeLifecycle(cfg, undefined, {
      binaryPathOverride: fixture.path,
      configPathOverride: join(fixture.dir, 'opencode-config.json'),
    })
    try {
      await opencode.start()
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        try {
          await stat(capturePath)
          break
        } catch {
          await Bun.sleep(10)
        }
      }
      expect(await readFile(capturePath, 'utf8')).toBe('1')
    } finally {
      await opencode.stop()
      if (previousFormat === undefined) delete process.env.KORTIX_COMPILED_RUNTIME_FORMAT
      else process.env.KORTIX_COMPILED_RUNTIME_FORMAT = previousFormat
      if (previousCapture === undefined) delete process.env.CAPTURE_PATH
      else process.env.CAPTURE_PATH = previousCapture
    }
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
    const opencode = createOpencodeLifecycle(cfg, undefined, {
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

  test('OpenCode spawns before the checkout completes; the clone is handed over, not awaited', async () => {
    const main = await readFile(resolve(import.meta.dir, '..', 'harness', 'open-code', 'boot.ts'), 'utf8')
    const repo = main.indexOf('const repoMaterializePromise')
    const bootPath = main.indexOf('await bootOpenCodeConfig({')
    expect(repo).toBeGreaterThan(-1)
    expect(bootPath).toBeGreaterThan(repo)
    // The clone is a PROMISE the boot path owns. `boot.ts` never awaits it, so
    // the spawn in step 0 never waits for the checkout.
    expect(main).not.toContain('await repoMaterializePromise')
    expect(main.slice(bootPath, main.indexOf('})', main.indexOf('onReady:', bootPath)))).toContain(
      'workspace: repoMaterializePromise',
    )
    const path = await readFile(resolve(import.meta.dir, '..', 'harness', 'open-code', 'boot-config-path.ts'), 'utf8')
    expect(path.indexOf('const started = input.start()')).toBeLessThan(path.indexOf('await input.workspace'))
  })

  test('starts the LLM proxy before OpenCode can spawn', async () => {
    const main = await readFile(resolve(import.meta.dir, '..', 'harness', 'open-code', 'boot.ts'), 'utf8')
    const llmProxyStart = main.indexOf('const llmUrl = startLlmProxy(')
    const llmProxyExport = main.indexOf('process.env.KORTIX_LLM_PROXY_URL = llmUrl', llmProxyStart)
    const bootPath = main.indexOf('await bootOpenCodeConfig({')

    expect(llmProxyStart).toBeGreaterThan(-1)
    expect(llmProxyExport).toBeGreaterThan(llmProxyStart)
    expect(bootPath).toBeGreaterThan(llmProxyExport)
  })
})
