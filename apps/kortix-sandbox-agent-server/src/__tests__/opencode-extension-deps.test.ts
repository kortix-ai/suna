/**
 * A kortix.yaml v3 OpenCode extension resolves its npm dependencies.
 *
 * The extension folder (the nearest `package.json` below the config root)
 * is staged outside the repository, next to a `node_modules` that is the
 * image-baked tree when it satisfies the declared dependencies, else an
 * install. The plugin is loaded from the staged copy, so a bare import
 * resolves. Nothing is written into the config root.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stageExtensionModule } from '@/harness/open-code/extension-deps'
import { buildOpencodeConfigContent } from '@/harness/open-code/lifecycle'

let root: string
let configRoot: string
let cache: string
let baked: string

function write(base: string, path: string, content: string) {
  mkdirSync(dirname(join(base, path)), { recursive: true })
  writeFileSync(join(base, path), content)
}

/** A package a plugin can import: its default export names its version. */
function fakePackage(modules: string, name: string, version: string) {
  write(modules, `${name}/package.json`, JSON.stringify({ name, version, main: 'index.js' }))
  write(modules, `${name}/index.js`, `module.exports = { version: ${JSON.stringify(version)} }\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-ext-deps-'))
  configRoot = join(root, 'repo')
  cache = join(root, 'cache')
  baked = join(root, 'baked')
  // The extension: a plugin that imports a dependency through a relative module.
  write(configRoot, 'extensions/demo/package.json', JSON.stringify({ name: 'demo', dependencies: { 'kortix-fixture-dep': '1.2.3' } }))
  write(configRoot, 'extensions/demo/lib/dep.ts', "import dep from 'kortix-fixture-dep'\nexport const version: string = dep.version\n")
  write(configRoot, 'extensions/demo/plugin.ts', "import { version } from './lib/dep'\nexport default async () => version\n")
  mkdirSync(join(baked, 'node_modules'), { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const load = async (spec: string) => ((await import(spec)) as { default: () => Promise<string> }).default()

describe('stageExtensionModule', () => {
  test('baked deps that satisfy the declared ones are linked: the plugin imports them, nothing is installed', async () => {
    fakePackage(join(baked, 'node_modules'), 'kortix-fixture-dep', '1.2.3')
    const installs: string[] = []
    const spec = await stageExtensionModule(configRoot, 'extensions/demo/plugin.ts', {
      cacheRoot: cache,
      bakedDir: baked,
      install: async (dir) => void installs.push(dir),
    })
    expect(spec).toStartWith(pathToFileURL(cache).href)
    expect(await load(spec!)).toBe('1.2.3')
    expect(installs).toEqual([])
    expect(lstatSync(join(new URL(spec!).pathname, '../node_modules')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(configRoot, 'extensions/demo/node_modules'))).toBe(false)
  })

  test('baked deps that do not satisfy them are installed into the staged copy', async () => {
    fakePackage(join(baked, 'node_modules'), 'kortix-fixture-dep', '9.9.9')
    const spec = await stageExtensionModule(configRoot, 'extensions/demo/plugin.ts', {
      cacheRoot: cache,
      bakedDir: baked,
      install: async (dir) => fakePackage(join(dir, 'node_modules'), 'kortix-fixture-dep', '1.2.3'),
    })
    expect(await load(spec!)).toBe('1.2.3')
    expect(readdirSync(configRoot, { recursive: true }).some((path) => String(path).includes('node_modules'))).toBe(false)
  })

  test('an unchanged extension reuses its staged copy; a changed one gets a new one', async () => {
    fakePackage(join(baked, 'node_modules'), 'kortix-fixture-dep', '1.2.3')
    const opts = { cacheRoot: cache, bakedDir: baked, install: async () => undefined }
    const first = await stageExtensionModule(configRoot, 'extensions/demo/plugin.ts', opts)
    expect(await stageExtensionModule(configRoot, 'extensions/demo/plugin.ts', opts)).toBe(first)
    write(configRoot, 'extensions/demo/plugin.ts', "import { version } from './lib/dep'\nexport default async () => `v${version}`\n")
    const second = await stageExtensionModule(configRoot, 'extensions/demo/plugin.ts', opts)
    expect(second).not.toBe(first)
    expect(await load(second!)).toBe('v1.2.3')
  })

  test('an install that fails skips the plugin: null, and no staged copy is left', async () => {
    const spec = await stageExtensionModule(configRoot, 'extensions/demo/plugin.ts', {
      cacheRoot: cache,
      bakedDir: baked,
      install: async () => {
        throw new Error('registry unreachable')
      },
    })
    expect(spec).toBeNull()
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([])
  })

  test('a module with no package.json below the config root loads from the repository as it is', async () => {
    write(configRoot, 'package.json', JSON.stringify({ name: 'the-repo', dependencies: { left: '1.0.0' } }))
    write(configRoot, 'ext/plain.ts', 'export default async () => "plain"\n')
    const spec = await stageExtensionModule(configRoot, 'ext/plain.ts', { cacheRoot: cache, bakedDir: baked })
    expect(spec).toBe(pathToFileURL(join(configRoot, 'ext/plain.ts')).href)
    expect(existsSync(cache)).toBe(false)
  })
})

describe('buildOpencodeConfigContent stages a v3 extension with dependencies', () => {
  test('the plugin spec points at the staged copy under the runtime state dir', async () => {
    const state = join(root, 'state')
    const set = {
      schema: 3,
      default_agent: 'lead',
      agent: { lead: { mode: 'primary', extensions: ['demo'] } },
      extensions: { demo: { opencode: 'extensions/demo/plugin.ts' } },
    }
    const config = JSON.parse(
      (await buildOpencodeConfigContent(
        { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(set), KORTIX_RUNTIME_STATE_DIR: state },
        { configRoot, extensionDeps: { bakedDir: baked, install: async (dir) => fakePackage(join(dir, 'node_modules'), 'kortix-fixture-dep', '1.2.3') } },
      ))!,
    )
    expect(config.plugin).toHaveLength(1)
    expect(config.plugin[0]).toStartWith(pathToFileURL(join(state, 'opencode/extensions')).href)
    expect(await load(config.plugin[0])).toBe('1.2.3')
  })
})
