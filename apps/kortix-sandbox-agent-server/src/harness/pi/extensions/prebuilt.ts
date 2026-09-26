/**
 * Project packages from the API's pre-built bundle (apps/api/src/pi-packages/prebuild.ts).
 *
 * Each extension entry arrives as ONE self-contained ESM file whose imports of
 * the modules pi hands every extension read `globalThis.__kortixPiHost`. Filled
 * here from the modules already in this binary, the file loads with Bun's
 * native import: no jiti, no transpile cache (both packages of the bench:
 * 50-53 ms vs 436 ms cold through jiti, compiled binary on macOS).
 *
 * A package the API could not pre-build, a native import that throws, or an
 * entry with its own `extensions` filter (pi's to apply) goes to `fallback`:
 * the runtime loads it from the installed `node_modules` bundle instead.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as piAgentCore from '@earendil-works/pi-agent-core'
import * as piAi from '@earendil-works/pi-ai/compat'
import * as piAiOauth from '@earendil-works/pi-ai/oauth'
import * as piAiProviders from '@earendil-works/pi-ai/providers/all'
import * as piCodingAgent from '@earendil-works/pi-coding-agent'
import type { ExtensionFactory, InlineExtension, PackageSource } from '@earendil-works/pi-coding-agent'
import * as piTui from '@earendil-works/pi-tui'
import * as typebox from 'typebox'
import * as typeboxCompile from 'typebox/compile'
import * as typeboxValue from 'typebox/value'
import { logger } from '../../../logger'
import { parseNpmSource } from './host'

/** pi-coding-agent's VIRTUAL_MODULES, keyed exactly as prebuild.ts rewrites the imports. */
function hostModules(): Record<string, unknown> {
  const modules: Record<string, unknown> = {
    typebox,
    'typebox/compile': typeboxCompile,
    'typebox/value': typeboxValue,
    '@earendil-works/pi-agent-core': piAgentCore,
    '@earendil-works/pi-tui': piTui,
    '@earendil-works/pi-ai': piAi,
    '@earendil-works/pi-ai/compat': piAi,
    '@earendil-works/pi-ai/oauth': piAiOauth,
    '@earendil-works/pi-ai/providers/all': piAiProviders,
    '@earendil-works/pi-coding-agent': piCodingAgent,
  }
  for (const [name, value] of Object.entries(modules)) {
    if (name.startsWith('typebox')) modules[name.replace('typebox', '@sinclair/typebox')] = value
    if (name.startsWith('@earendil-works/')) modules[name.replace('@earendil-works/', '@mariozechner/')] = value
  }
  return modules
}

type PrebuiltPackage = { name: string; version: string; dir: string; extensions: string[] } | { name: string; version: string; fallback: string }

export interface PrebuiltResult {
  /** One inline extension per pre-built entry, named by the package source. */
  extensions: InlineExtension[]
  /** Package folders for pi to read skills/prompts/themes from (its extensions are the ones above). */
  resources: PackageSource[]
  /** npm entries to load from the node_modules bundle instead, with why. */
  fallback: Array<{ entry: PackageSource; reason: string }>
}

function sourceOf(entry: PackageSource): string {
  return typeof entry === 'string' ? entry : entry.source
}

/** Load the project's npm entries from an unpacked pre-built bundle; everything else is the caller's. */
export async function loadPrebuiltPackages(root: string, entries: readonly PackageSource[]): Promise<PrebuiltResult> {
  const result: PrebuiltResult = { extensions: [], resources: [], fallback: [] }
  let packages: PrebuiltPackage[]
  try {
    packages = (JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { packages: PrebuiltPackage[] }).packages
  } catch (err) {
    logger.warn('[pi] pre-built bundle has no readable manifest', { root, err: (err as Error).message })
    packages = []
  }
  ;(globalThis as { __kortixPiHost?: Record<string, unknown> }).__kortixPiHost ??= hostModules()
  for (const entry of entries) {
    const source = sourceOf(entry)
    const npm = parseNpmSource(source)
    if (!npm) continue
    const built = packages.find((pkg) => pkg.name === npm.name)
    if (!built) {
      result.fallback.push({ entry, reason: 'not in the pre-built bundle' })
      continue
    }
    if ('fallback' in built) {
      result.fallback.push({ entry, reason: built.fallback })
      continue
    }
    if (typeof entry !== 'string' && entry.extensions !== undefined) {
      result.fallback.push({ entry, reason: 'the entry filters its extensions' })
      continue
    }
    try {
      const factories: InlineExtension[] = []
      for (const file of built.extensions) {
        const module = (await import(join(root, file))) as { default?: unknown }
        if (typeof module.default !== 'function') throw new Error(`${file} has no default export function`)
        factories.push({ name: source, factory: module.default as ExtensionFactory })
      }
      result.extensions.push(...factories)
      const dir = join(root, built.dir)
      result.resources.push(typeof entry === 'string' ? { source: dir, extensions: [] } : { ...entry, source: dir, extensions: [] })
    } catch (err) {
      result.fallback.push({ entry, reason: `native load failed: ${(err as Error).message}` })
    }
  }
  return result
}
