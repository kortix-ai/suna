import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { loadConfig, readProjectManifest, extractNestedString, type Config as HostConfig } from '../../config'

type Config = OpenCodeConfig

/**
 * Pick the opencode config dir for this sandbox. Honors `opencode.config_dir` in
 * the project's manifest (kortix.yaml, or legacy kortix.toml) when present,
 * defaulting to `.kortix/opencode` relative to the cloned repo, and falls back
 * to KORTIX_DEFAULT_OPENCODE_CONFIG_DIR if the project doesn't have an
 * opencode.jsonc — that's what keeps a freshly provisioned sandbox bootable
 * before a project has been cloned.
 */
export async function resolveOpencodeConfigDir(cfg: Config): Promise<string> {
  const fs = await import('node:fs/promises')
  const relConfigDir = await readOpencodeConfigDirFromManifest(fs, cfg.projectTarget)
  const candidate = `${cfg.projectTarget}/${relConfigDir}`
  for (const filename of ['opencode.jsonc', 'opencode.json']) {
    try {
      const stat = await fs.stat(`${candidate}/${filename}`)
      if (stat.isFile()) {
        try {
          await fs.mkdir(candidate, { recursive: true })
        } catch {}
        return candidate
      }
    } catch {}
  }
  try {
    await fs.mkdir(cfg.defaultOpencodeConfigDir, { recursive: true })
  } catch {}
  return cfg.defaultOpencodeConfigDir
}

/**
 * Pluck `opencode.config_dir` out of the project manifest without dragging in a
 * full parser. Resolves kortix.yaml first, then legacy kortix.toml, and reads
 * the field from whichever format it found. Falls back to the default if the
 * manifest is absent or anything's off.
 */
async function readOpencodeConfigDirFromManifest(
  fs: typeof import('node:fs/promises'),
  projectTarget: string,
): Promise<string> {
  const fallback = '.kortix/opencode'
  const manifest = await readProjectManifest(fs, projectTarget)
  if (!manifest) return fallback
  const rawValue = extractNestedString(manifest.body, manifest.format, 'opencode', 'config_dir')
  if (!rawValue) return fallback
  const raw = rawValue.trim().replace(/\/+$/, '')
  // Reject absolute paths and parent traversal — matches the API's validator.
  if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) return fallback
  return raw
}

/** Native environment contract; names and defaults are unchanged. */
const EnvironmentSchema = z.object({
  KORTIX_OPENCODE_INTERNAL_PORT: z.coerce.number().int().positive().default(4096),
  // The other half of the opencode port PAIR. A verified reload boots the new
  // opencode on whichever of the two is idle, proves it serves, and only then
  // swaps to it and kills the old one — so a config that cannot boot never
  // takes the session down with it.
  //
  // Fixed rather than picked at reload time on purpose: both ports must be in
  // the web proxy's blocked-self-ports set, and that set is built once at
  // startup. An ephemeral port would be unguarded the moment it went live,
  // handing the sandbox an unproxied route to its own opencode.
  KORTIX_OPENCODE_STANDBY_PORT: z.coerce.number().int().positive().default(4097),
  KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: z
    .string()
    .default('/ephemeral/kortix-master/opencode'),
})

export interface OpenCodeEnvironment {
  opencodeInternalPort: number
  /** Idle half of the opencode port pair; see KORTIX_OPENCODE_STANDBY_PORT. */
  opencodeStandbyPort: number
  defaultOpencodeConfigDir: string
}

export function loadOpenCodeEnvironment(env: NodeJS.ProcessEnv): OpenCodeEnvironment {
  const parsed = EnvironmentSchema.parse(env)
  return {
    opencodeInternalPort: parsed.KORTIX_OPENCODE_INTERNAL_PORT,
    opencodeStandbyPort: parsed.KORTIX_OPENCODE_STANDBY_PORT,
    defaultOpencodeConfigDir: parsed.KORTIX_DEFAULT_OPENCODE_CONFIG_DIR,
  }
}

/** Authored/native skill locations, in existing fallback order. */
export async function resolveOpenCodeSkillDirectories(cfg: Config): Promise<string[]> {
  const directories: string[] = []
  try { directories.push(join(await resolveOpencodeConfigDir(cfg), "skills")) } catch {}
  directories.push(join(cfg.workspace || "/workspace", ".kortix/opencode/skills"))
  directories.push(join(homedir(), ".opencode/skills"))
  return directories
}

/** Complete configuration visible only inside the OpenCode implementation. */
export type OpenCodeConfig = HostConfig & OpenCodeEnvironment

/**
 * Narrow the selected adapter's flat configuration without cloning or reading
 * process.env again. The host never needs to inspect these native fields.
 */
export function requireOpenCodeConfig(cfg: HostConfig): OpenCodeConfig {
  if (
    !('opencodeInternalPort' in cfg) || typeof cfg.opencodeInternalPort !== 'number' ||
    !('opencodeStandbyPort' in cfg) || typeof cfg.opencodeStandbyPort !== 'number' ||
    !('defaultOpencodeConfigDir' in cfg) || typeof cfg.defaultOpencodeConfigDir !== 'string'
  ) {
    throw new Error('Selected OpenCode harness requires its resolved configuration')
  }
  return cfg as OpenCodeConfig
}

/** Re-read all session environment values during native warm adoption. */
export function loadOpenCodeConfig(env: NodeJS.ProcessEnv = process.env): OpenCodeConfig {
  return requireOpenCodeConfig(loadConfig(env))
}
