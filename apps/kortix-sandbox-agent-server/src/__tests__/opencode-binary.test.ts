import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parsePnpmGlobalPackagePath,
  publishOpencodeNativeLink,
  resolveInstalledOpencodeNative,
} from '../opencode-binary'
import { detectOpencodeBinary } from '../opencode'
import { installOpencodeVersion } from '../runtime-assets'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-opencode-binary-'))
  tempDirs.push(dir)
  return dir
}

async function executable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('pnpm OpenCode native binary resolution', () => {
  test('selects the pnpm v11 package directory instead of the global root', () => {
    const root = '/home/kortix/.local/share/pnpm/global/v11'
    const packagePath = `${root}/1423c-1a022964b2a-a2220588c319339d/node_modules/opencode-ai`

    expect(parsePnpmGlobalPackagePath(`${root}\n${packagePath}\n`)).toBe(packagePath)
  })

  test('rejects root-only, relative, and lookalike output', () => {
    expect(parsePnpmGlobalPackagePath('/home/kortix/.local/share/pnpm/global/v11\n')).toBeNull()
    expect(parsePnpmGlobalPackagePath('node_modules/opencode-ai\n')).toBeNull()
    expect(
      parsePnpmGlobalPackagePath('/tmp/node_modules/opencode-ai-malicious\n'),
    ).toBeNull()
  })

  test('resolves bin/opencode.exe and verifies it is executable', async () => {
    const dir = await tempDir()
    const packagePath = join(dir, 'global', 'v11', 'hash', 'node_modules', 'opencode-ai')
    const nativePath = join(packagePath, 'bin', 'opencode.exe')
    await mkdir(join(packagePath, 'bin'), { recursive: true })
    await Bun.write(join(packagePath, 'package.json'), '{}')
    await executable(nativePath)
    const calls: Array<{ file: string; args: string[] }> = []

    const resolved = await resolveInstalledOpencodeNative(async (file, args) => {
      calls.push({ file, args })
      return `${join(dir, 'global', 'v11')}\n${packagePath}\n`
    })

    expect(resolved).toBe(nativePath)
    expect(calls).toEqual([
      {
        file: 'pnpm',
        args: ['list', '-g', '--parseable', '--depth', '0', 'opencode-ai'],
      },
    ])
  })
})

describe('OpenCode launch binary detection', () => {
  test('uses the PATH launcher without pnpm discovery when the experiment is disabled', async () => {
    const events: string[] = []

    const resolved = await detectOpencodeBinary({
      nativeBinaryFastPathEnabled: false,
      currentLink: '/test/opencode.current',
      systemLink: '/test/opencode-kortix',
      isExecutable: async (path) => {
        events.push(`executable:${path}`)
        return false
      },
      resolveInstalledNative: async () => {
        events.push('resolve-native')
        return '/test/opencode.exe'
      },
      publishNativeLink: async () => {
        events.push('publish-native')
      },
      findOnPath: async (name) => {
        events.push(`path:${name}`)
        return '/test/opencode'
      },
    })

    expect(resolved).toBe('/test/opencode')
    expect(events).toEqual(['path:opencode'])
  })

  test('uses an existing stable link when the experiment is enabled', async () => {
    const events: string[] = []

    const resolved = await detectOpencodeBinary({
      nativeBinaryFastPathEnabled: true,
      currentLink: '/test/opencode.current',
      systemLink: '/test/opencode-kortix',
      isExecutable: async (path) => {
        events.push(`executable:${path}`)
        return path === '/test/opencode.current'
      },
      resolveInstalledNative: async () => {
        events.push('resolve-native')
        return '/test/opencode.exe'
      },
      publishNativeLink: async () => {
        events.push('publish-native')
      },
      findOnPath: async (name) => {
        events.push(`path:${name}`)
        return '/test/opencode'
      },
    })

    expect(resolved).toBe('/test/opencode.current')
    expect(events).toEqual(['executable:/test/opencode.current'])
  })

  test('falls back to an existing stable link when the disabled PATH launcher is missing', async () => {
    const events: string[] = []

    const resolved = await detectOpencodeBinary({
      nativeBinaryFastPathEnabled: false,
      currentLink: '/test/opencode.current',
      systemLink: '/test/opencode-kortix',
      isExecutable: async (path) => {
        events.push(`executable:${path}`)
        return path === '/test/opencode.current'
      },
      resolveInstalledNative: async () => {
        events.push('resolve-native')
        return '/test/opencode.exe'
      },
      publishNativeLink: async () => {
        events.push('publish-native')
      },
      findOnPath: async (name) => {
        events.push(`path:${name}`)
        return null
      },
    })

    expect(resolved).toBe('/test/opencode.current')
    expect(events).toEqual(['path:opencode', 'executable:/test/opencode.current'])
  })

  test('repairs a legacy image through pnpm only when the experiment is enabled', async () => {
    const events: string[] = []

    const resolved = await detectOpencodeBinary({
      nativeBinaryFastPathEnabled: true,
      currentLink: '/test/opencode.current',
      systemLink: '/test/opencode-kortix',
      isExecutable: async (path) => {
        events.push(`executable:${path}`)
        return false
      },
      resolveInstalledNative: async () => {
        events.push('resolve-native')
        return '/test/opencode.exe'
      },
      publishNativeLink: async (nativePath, linkPath) => {
        events.push(`publish-native:${nativePath}:${linkPath}`)
      },
      findOnPath: async (name) => {
        events.push(`path:${name}`)
        return '/test/opencode'
      },
    })

    expect(resolved).toBe('/test/opencode.current')
    expect(events).toEqual([
      'executable:/test/opencode.current',
      'executable:/test/opencode-kortix',
      'resolve-native',
      'publish-native:/test/opencode.exe:/test/opencode.current',
    ])
  })
})

describe('OpenCode native stable link', () => {
  test('atomically replaces an existing link and removes the temporary link', async () => {
    const dir = await tempDir()
    const oldNative = join(dir, 'old-opencode')
    const newNative = join(dir, 'new-opencode')
    const current = join(dir, 'opencode.current')
    await executable(oldNative)
    await executable(newNative)
    await symlink(oldNative, current)

    await publishOpencodeNativeLink(newNative, current)

    expect(await readlink(current)).toBe(newNative)
    expect((await readdir(dir)).filter((name) => name.startsWith('opencode.current.next-'))).toEqual(
      [],
    )
  })

  test('keeps the previous link when the new target is missing', async () => {
    const dir = await tempDir()
    const oldNative = join(dir, 'old-opencode')
    const missing = join(dir, 'missing-opencode')
    const current = join(dir, 'opencode.current')
    await executable(oldNative)
    await symlink(oldNative, current)

    await expect(publishOpencodeNativeLink(missing, current)).rejects.toBeTruthy()

    expect(await readlink(current)).toBe(oldNative)
    expect((await readdir(dir)).filter((name) => name.startsWith('opencode.current.next-'))).toEqual(
      [],
    )
  })

  test('keeps the previous link when the new target is not executable', async () => {
    const dir = await tempDir()
    const oldNative = join(dir, 'old-opencode')
    const newNative = join(dir, 'new-opencode')
    const current = join(dir, 'opencode.current')
    await executable(oldNative)
    await writeFile(newNative, 'not executable')
    await symlink(oldNative, current)

    await expect(publishOpencodeNativeLink(newNative, current)).rejects.toBeTruthy()

    expect(await readlink(current)).toBe(oldNative)
  })
})

describe('OpenCode runtime installation', () => {
  test('publishes the validated native target after pnpm install', async () => {
    const dir = await tempDir()
    const packagePath = join(dir, 'global', 'v11', 'hash', 'node_modules', 'opencode-ai')
    const nativePath = join(packagePath, 'bin', 'opencode.exe')
    const oldNative = join(dir, 'old-opencode')
    const current = join(dir, 'opencode.current')
    await mkdir(join(packagePath, 'bin'), { recursive: true })
    await executable(nativePath)
    await executable(oldNative)
    await symlink(oldNative, current)
    const events: string[] = []

    await installOpencodeVersion('1.18.19', {
      currentLinkPath: current,
      installPackage: async (version) => {
        events.push(`install:${version}`)
      },
      capture: async (file, args) => {
        if (file === 'pnpm') {
          events.push(`resolve:${args.join(' ')}`)
          return `${join(dir, 'global', 'v11')}\n${packagePath}\n`
        }
        events.push(`version:${file}`)
        return '1.18.19\n'
      },
    })

    expect(events).toEqual([
      'install:1.18.19',
      'resolve:list -g --parseable --depth 0 opencode-ai',
      `version:${nativePath}`,
    ])
    expect(await readlink(current)).toBe(nativePath)
  })

  test('keeps the previous target when the native version is wrong', async () => {
    const dir = await tempDir()
    const packagePath = join(dir, 'global', 'v11', 'hash', 'node_modules', 'opencode-ai')
    const nativePath = join(packagePath, 'bin', 'opencode.exe')
    const oldNative = join(dir, 'old-opencode')
    const current = join(dir, 'opencode.current')
    await mkdir(join(packagePath, 'bin'), { recursive: true })
    await executable(nativePath)
    await executable(oldNative)
    await symlink(oldNative, current)

    await expect(
      installOpencodeVersion('1.18.19', {
        currentLinkPath: current,
        installPackage: async () => {},
        capture: async (file) =>
          file === 'pnpm' ? `${packagePath}\n` : '1.18.18\n',
      }),
    ).rejects.toThrow('expected 1.18.19, got 1.18.18')

    expect(await readlink(current)).toBe(oldNative)
  })
})
