import { createHash } from 'node:crypto'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { overlayHash, readOverlayFromDisk, writeState, fileSha256 } from './runtime-assets-state'
import type { RuntimeAssetsState } from './runtime-assets'

const DEFAULT_CLI_PATH = '/usr/local/bin/kortix'
const DEFAULT_AGENT_BAKED_PATH = '/usr/local/bin/kortix-agent'
const DEFAULT_MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills'
const DEFAULT_STATE_PATH = '/opt/kortix/runtime-assets-state.json'
/** What {@link bakeRuntimeAssetsState} may be pointed at. Defaults are the image paths. */
export interface BakeRuntimeAssetsStateOptions {
  cliPath?: string
  agentPath?: string
  managedSkillsDir?: string
  statePath?: string
  /**
   * The OpenCode release this image installs. Omitted reads it from the
   * symlink every image definition creates
   * ({@link DEFAULT_OPENCODE_CURRENT_LINK}); unreadable leaves the field
   * unset rather than guessed, and the first pass fills it in.
   */
  opencodeVersion?: string
}

/** The launcher symlink all three image definitions point at their OpenCode. */
const DEFAULT_OPENCODE_CURRENT_LINK = '/opt/kortix/opencode.current'

/** `opencode --version` prints a bare version, so the binary can be asked. */
async function bakedOpencodeVersion(path: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return undefined
    const version = out.trim()
    return /^\d+\.\d+\.\d+/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * IMAGE BUILD ONLY. State which runtime assets this image carries.
 *
 * THE DEFECT THIS FIXES. Baking the CLI, the daemon and the skill overlay into
 * an image is only half of "this box is current". The other half is the box
 * being able to SAY so: `runtime-assets-state.json` was written by a completed
 * reconcile and by nothing else, so a freshly booted box answered
 * `runtime.running` with nulls — every digest unknown — until its first pass
 * finished. Measured on a cold preview box: boot 23:41:53, first pass complete
 * 23:44:15, a ~140 s window in which the control plane could not tell a current
 * box from a months-old one. Worse, the pass was not free: with no recorded
 * hash the overlay check could not short-circuit, so every cold box downloaded
 * an overlay it already had, and hashed ~210 MB of binaries to learn nothing.
 *
 * Running it at image build rather than at boot is the whole point. The mtimes
 * recorded here are the ones the files will still have on every box that starts
 * from this image, so {@link localDigest} answers from the cache and the first
 * reconcile reads the manifest and stops.
 *
 * FAILS LOUD, unlike every other write in this module. Everything else here is
 * best-effort because a live box must survive a bad API; this runs in `docker
 * build`, where a missing artifact means the image is wrong and shipping it
 * would put a confident lie on every box it starts.
 */
export async function bakeRuntimeAssetsState(
  options: BakeRuntimeAssetsStateOptions = {},
): Promise<RuntimeAssetsState> {
  const cliPath = options.cliPath ?? DEFAULT_CLI_PATH
  const agentPath = options.agentPath ?? DEFAULT_AGENT_BAKED_PATH
  const skillsDir = options.managedSkillsDir ?? DEFAULT_MANAGED_SKILLS_DIR
  const statePath = options.statePath ?? DEFAULT_STATE_PATH

  const cli = await localDigest(cliPath, {})
  if (!cli) throw new Error(`bake-runtime-assets-state: no kortix CLI at ${cliPath}`)
  const agent = await localDigest(agentPath, {})
  if (!agent) throw new Error(`bake-runtime-assets-state: no kortix-agent at ${agentPath}`)
  const overlay = await readOverlayFromDisk(skillsDir)
  if (overlay.length === 0) {
    throw new Error(`bake-runtime-assets-state: no managed-skill overlay at ${skillsDir}`)
  }

  const state: RuntimeAssetsState = {
    cli_path: cliPath,
    cli_sha256: cli.sha,
    cli_size: cli.size,
    cli_mtime_ms: cli.mtimeMs,
    agent_path: agentPath,
    agent_sha256: agent.sha,
    agent_size: agent.size,
    agent_mtime_ms: agent.mtimeMs,
    managed_skills_hash: overlayHash(overlay),
  }
  const opencode =
    options.opencodeVersion ?? (await bakedOpencodeVersion(DEFAULT_OPENCODE_CURRENT_LINK))
  if (opencode) state.opencode_version = opencode
  // `build` is deliberately absent. It records the highest manifest epoch this
  // box has READ, and an image build reads no manifest. Claiming one would arm
  // the epoch guard against an API that is legitimately older than the image.
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')
  return state
}

interface LocalDigest {
  sha: string
  size: number
  mtimeMs: number
}

/**
 * A file's sha256, preferring a cached value when the file is provably
 * unchanged (same size AND same mtime).
 *
 * Hashing is not free at these sizes — the CLI is ~104 MB and the daemon ~96 MB
 * — and this runs on every session start, so a converged box must not pay for
 * two full reads to learn that nothing changed. The manifest is always trusted
 * over the cache: the cache only ever answers "what is on disk", never "what
 * should be".
 */
export async function localDigest(path: string, cached: Partial<LocalDigest>): Promise<LocalDigest | null> {
  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(path)
  } catch {
    return null
  }
  if (!stats.isFile()) return null
  const mtimeMs = Math.trunc(stats.mtimeMs)
  if (cached.sha && cached.size === stats.size && cached.mtimeMs === mtimeMs) {
    return { sha: cached.sha, size: stats.size, mtimeMs }
  }
  return { sha: await fileSha256(path), size: stats.size, mtimeMs }
}

export async function localCliSha(cliPath: string, state: RuntimeAssetsState): Promise<LocalDigest | null> {
  return localDigest(cliPath, {
    sha: state.cli_sha256,
    size: state.cli_size,
    mtimeMs: state.cli_mtime_ms,
  })
}
