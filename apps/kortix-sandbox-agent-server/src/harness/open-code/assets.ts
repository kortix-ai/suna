import { execFile } from 'node:child_process'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logger } from '../../logger'
import type {
  HarnessAssetOutcome,
  HarnessAssetsInput,
  HarnessAssetsResult,
  HarnessAssetsService,
} from '../assets'
import { requireOpenCodeConfig, resolveOpencodeConfigDir } from './config'
import { ensureInjectedManagedSkills } from './injected-skills'
import {
  captureProcessOutput,
  OPENCODE_CURRENT_LINK,
  publishOpencodeNativeLink,
  resolveInstalledOpencodeNative,
  type CaptureCommand,
} from './opencode-binary'
import { OPENCODE_CONFIG_DEPS_DIR } from './opencode-config-deps'
import { opencodeTurnInFlight } from './opencode-turn-state'

const execFileAsync = promisify(execFile)
/** opencode is ~167 MB from npm and installs on a 1-2 vCPU box. */
const OPENCODE_INSTALL_TIMEOUT_MS = 600_000
const OPENCODE_HEALTH_TIMEOUT_MS = 5_000

/** Live supervisor accessors are re-read after verified reload and warm adoption. */
export interface OpenCodeAssetsRuntime {
  getInternalUrl(): string
  workspace(): string
  restart(): Promise<void>
}

/** Native installer seams stay with the implementation that understands them. */
export interface OpenCodeAssetsOptions {
  installOpencode?: (version: string) => Promise<void>
  readOpencodeVersion?: (baseUrl: string) => Promise<string | null>
  opencodeBinaryExists?: () => Promise<boolean>
  turnProbe?: (baseUrl: string, workspace: string) => Promise<boolean | null>
  opencodeDepsDir?: string
  installPluginDeps?: (dir: string) => Promise<void>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function manifestComponent(components: unknown, name: string): { version?: unknown } | null {
  if (!components || typeof components !== 'object' || Array.isArray(components)) return null
  const entry = (components as Record<string, unknown>)[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return entry as { version?: unknown }
}

// ── opencode ───────────────────────────────────────────────────────────────

/**
 * A version string that is safe to hand to a package manager.
 *
 * The value comes off the manifest and becomes an ARGUMENT of an install
 * command run as the sandbox user. `execFile` (no shell) is the primary
 * control; this allowlist is the second, so a malformed or hostile value is
 * refused loudly instead of being executed at all.
 */
const OPENCODE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/

const OPENCODE_PLUGIN_PACKAGE = '@opencode-ai/plugin'

/** The version opencode itself reports. `null` when it cannot be read — which
 *  is NOT the same as "mismatched", and never converges anything. */
async function readOpencodeVersion(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/global/health`, {
      signal: AbortSignal.timeout(OPENCODE_HEALTH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return optionalString(body?.version) ?? null
  } catch {
    return null
  }
}

/**
 * Install one exact opencode version, exactly the way the image does.
 *
 * `pnpm add -g --allow-build=opencode-ai` is not a stylistic choice — it is the
 * command in `dockerfile-layer.ts`, and the point of convergence is that a box
 * that updates itself ends up byte-identical to a box built fresh. A different
 * installer here would produce a second, subtly different runtime that only
 * ever exists on updated boxes, which is the hardest kind of drift to debug.
 */
export interface InstallOpencodeVersionOptions {
  installPackage?: (version: string) => Promise<void>
  capture?: CaptureCommand
  currentLinkPath?: string
}

export async function installOpencodeVersion(
  version: string,
  options: InstallOpencodeVersionOptions = {},
): Promise<void> {
  const installPackage = options.installPackage ?? (async (targetVersion: string) => {
    await execFileAsync(
      'pnpm',
      ['add', '-g', '--allow-build=opencode-ai', `opencode-ai@${targetVersion}`],
      { timeout: OPENCODE_INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    )
  })
  const capture = options.capture ?? captureProcessOutput

  await installPackage(version)
  const nativePath = await resolveInstalledOpencodeNative(capture)
  const reportedVersion = (await capture(nativePath, ['--version'])).trim()
  if (reportedVersion !== version) {
    throw new Error(
      `installed OpenCode native version mismatch: expected ${version}, got ${reportedVersion || '<empty>'}`,
    )
  }
  await publishOpencodeNativeLink(
    nativePath,
    options.currentLinkPath ?? OPENCODE_CURRENT_LINK,
  )
}

async function installPluginDeps(dir: string): Promise<void> {
  await execFileAsync('bun', ['install'], {
    cwd: dir,
    timeout: OPENCODE_INSTALL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
}

/**
 * The `@opencode-ai/plugin` pin that must track the opencode BINARY version.
 *
 * opencode loads the plugin SDK matching its own binary and fetches it over the
 * network when it is absent — on every boot. That is the multi-second
 * `opencode-session-created` stall documented in
 * `packages/shared/src/sandbox/dockerfile-layer.ts`, and it is why a version
 * bump that moves the binary without the pin is worse than not bumping at all.
 *
 * Only the BAKED dependency dir is rewritten. The project's own config-dir
 * `package.json` is a tracked file in the user's repository; convergence
 * writing into a working tree would dirty it and show up as an unexplained
 * local change in their next `git status`.
 */
async function readPluginPin(depsDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(depsDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
    }
    return optionalString(pkg?.dependencies?.[OPENCODE_PLUGIN_PACKAGE]) ?? null
  } catch {
    return null
  }
}

export async function refreshOpencodePluginPin(
  depsDir: string,
  version: string,
): Promise<'updated' | 'current' | 'absent' | 'failed'> {
  const pkgPath = join(depsDir, 'package.json')
  let pkg: { dependencies?: Record<string, unknown> }
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { dependencies?: Record<string, unknown> }
  } catch {
    // No baked dependency dir on this image (self-host, an old snapshot). The
    // binary still converges; opencode just pays its own plugin fetch.
    return 'absent'
  }
  if (!pkg.dependencies || typeof pkg.dependencies[OPENCODE_PLUGIN_PACKAGE] !== 'string') {
    return 'absent'
  }
  if (pkg.dependencies[OPENCODE_PLUGIN_PACKAGE] === version) return 'current'
  pkg.dependencies[OPENCODE_PLUGIN_PACKAGE] = version
  const tmpPath = `${pkgPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await writeFile(tmpPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    await rename(tmpPath, pkgPath)
    return 'updated'
  } catch (err) {
    logger.warn('[runtime-assets] could not rewrite the opencode plugin pin', {
      depsDir,
      err: String(err),
    })
    return 'failed'
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {})
  }
}

async function reconcileOpenCodeAssets(
  { manifest, setActivity }: HarnessAssetsInput,
  runtime: OpenCodeAssetsRuntime | undefined,
  options: OpenCodeAssetsOptions,
): Promise<HarnessAssetsResult> {
  const v2 = Boolean(
    manifest.components &&
    typeof manifest.components === 'object' &&
    !Array.isArray(manifest.components),
  )
  const reasons: Record<string, string> = {}
  const nextState: Record<string, string> = {}
  // ── opencode — IDLE ONLY ───────────────────────────────────────────────────
  // Installing opencode replaces the binary the live model call is running in,
  // and applying it needs a restart. Both sever a turn in flight, so this half
  // only ever acts when the daemon's own turn oracle says the box is idle.
  // "Cannot tell" is treated as busy; a skipped pass costs nothing, because the
  // next start reconciles again.
  let opencode: HarnessAssetOutcome | undefined
  if (v2) {
    opencode = 'skipped'
    try {
      const component = manifestComponent(manifest.components, 'opencode')
      const expected = optionalString(component?.version)
      const seam = runtime
      const depsDir = options.opencodeDepsDir ?? OPENCODE_CONFIG_DEPS_DIR
      if (!expected) {
        reasons.opencode = 'manifest states no opencode version'
      } else if (!OPENCODE_VERSION.test(expected)) {
        // Refused, not sanitized: this value becomes an install argument.
        logger.warn('[runtime-assets] refusing a malformed opencode version', { expected })
        reasons.opencode = 'manifest opencode version is malformed'
      } else if (!seam) {
        // No live runtime in this process (monitor mode, a test, a pass fired
        // before opencode exists). Nothing to read a version from.
        reasons.opencode = 'no opencode runtime in this process'
      } else {
        const readVersion = options.readOpencodeVersion ?? readOpencodeVersion
        const installed = await readVersion(seam.getInternalUrl())
        const pin = await readPluginPin(depsDir)
        const binaryExists =
          installed !== null ||
          (await (options.opencodeBinaryExists ?? (async () => {
            try {
              await stat(OPENCODE_CURRENT_LINK)
              return true
            } catch {
              return false
            }
          }))())
        const binaryMissing = installed === null && !binaryExists
        const binaryStale = installed !== null && installed !== expected
        // The pin can drift from the binary on its own — a pass that installed
        // the binary and then failed the pin refresh leaves exactly that — and
        // a pin that does not match makes opencode refetch the plugin on every
        // boot. It is worth one idle-only repair even when the binary is fine.
        const pinStale = pin !== null && pin !== expected
        if (installed === null && !binaryMissing) {
          reasons.opencode = 'opencode did not report its version'
        } else if (installed !== null && !binaryMissing && !binaryStale && !pinStale) {
          opencode = 'current'
          nextState.opencode_version = installed
        } else {
          const probe = options.turnProbe ?? opencodeTurnInFlight
          // A missing managed binary cannot own a turn. Probing its absent
          // runtime returns "unreadable" forever and previously prevented old
          // snapshots from ever repairing themselves.
          const turnInFlight = binaryMissing
            ? false
            : await probe(seam.getInternalUrl(), seam.workspace())
          if (turnInFlight !== false) {
            reasons.opencode =
              turnInFlight === null ? 'turn state unreadable' : 'a turn is in flight'
            logger.info('[runtime-assets] opencode convergence deferred — box is busy', {
              installed,
              expected,
              turnInFlight,
            })
          } else {
            const install = options.installOpencode ?? installOpencodeVersion
            if (binaryStale || binaryMissing) {
              setActivity(`installing-opencode@${expected}`)
              try {
                await install(expected)
              } finally {
                setActivity(null)
              }
            }
            // SAME STEP as the binary, always. A binary and a plugin that
            // disagree is the state this whole block exists to avoid.
            const pinResult = await refreshOpencodePluginPin(depsDir, expected)
            if (pinResult === 'updated') {
              await (options.installPluginDeps ?? installPluginDeps)(depsDir)
            }
            // Only a NEW BINARY needs the process replaced: the plugin is read
            // when opencode boots, so a refreshed pin takes effect on its own at
            // the next start and buys nothing by cutting this one short.
            if (binaryStale || binaryMissing) await seam.restart()
            opencode = 'updated'
            nextState.opencode_version = expected
            logger.info('[runtime-assets] opencode converged', {
              from: installed,
              to: expected,
              pin: pinResult,
              restarted: binaryStale || binaryMissing,
            })
          }
        }
      }
    } catch (err) {
      logger.warn('[runtime-assets] opencode reconcile failed', { err: String(err) })
      opencode = 'failed'
      reasons.opencode = String(err)
    }
  }

  return {
    components: opencode === undefined ? {} : { opencode },
    reasons,
    state: nextState,
  }
}

/** Create the same maintenance operations with or without a live supervisor. */
export function createOpenCodeAssetsService(
  runtime?: OpenCodeAssetsRuntime,
  options: OpenCodeAssetsOptions = {},
): HarnessAssetsService {
  return {
    componentNames: ['opencode'],
    resolveConfigDir: (cfg) => resolveOpencodeConfigDir(requireOpenCodeConfig(cfg)),
    injectSkills: (configDir, bakedDir) => ensureInjectedManagedSkills(configDir, { bakedDir }),
    reconcile: (input) => reconcileOpenCodeAssets(input, runtime, options),
  }
}

/** Existing health/reconcile wire fields, retained for native compatibility. */
export interface OpenCodeAssetsCompatibilityResult {
  opencode?: HarnessAssetOutcome
}
