/**
 * How a new session box boots, decided in one place, from the project's own
 * feature flags (feature-flags/registry.ts):
 *
 *   Volumes off            → `standard`: the image alone.
 *   Volumes on             → `standard`, with Files and drive mounts.
 *   Stateless sessions on  → `volume`: an ephemeral box whose session state
 *                            lives on its own volume, plus the boot artifacts.
 *                            A stop retires the box (ephemeral-sandbox.ts).
 *
 * `artifacts` (the image plus the read-only boot-artifacts volume) is only a
 * fallback step. Off the volume provider every box boots `standard`.
 *
 * A session whose state already lives on a volume keeps it whatever the
 * flags say (session-sandbox.ts): booting it without the volume would lose
 * its files.
 *
 * Operator emergency overrides (env, not the product switch):
 * `KORTIX_EPHEMERAL_SANDBOXES=off` stops new volume boxes (a session that asks
 * for `volume` gets `artifacts`); `KORTIX_DRIVES_SESSION_MOUNT=off` boots
 * sessions without drive mounts.
 *
 * Fallback: a session whose boots keep failing in one mode steps down
 * volume → artifacts → standard, after {@link BOOT_FALLBACK} attempts each.
 * Failures are counted per session and per mode (on the session row), so a
 * session that degraded stays degraded. A session whose state already lives
 * on a volume never steps off it.
 *
 * Pure: no database, no config. The store lives in boot-mode-store.ts.
 */

export const BOOT_MODES = ['standard', 'artifacts', 'volume'] as const;
export type BootMode = (typeof BOOT_MODES)[number];

/** Failed boots allowed in a mode before the session steps down. */
export const BOOT_FALLBACK = { volumeAttempts: 2, artifactsAttempts: 2 } as const;

/**
 * Why a box boots in its mode. Records written before boot modes followed the
 * project flags may still name `kill_switch`, `org` or `default`.
 */
export type BootModeSource = 'provider' | 'volumes_off' | 'project' | 'session_volume' | 'kill_switch' | 'org' | 'default';

export interface BootModeDecision {
  mode: BootMode;
  source: BootModeSource;
  /** After the artifacts attempts are spent, try the image alone. */
  standardFallback: boolean;
  /** Set when the env switch turned a `volume` boot into `artifacts`. */
  capped?: 'env_volume_off';
}

export interface BootModeTarget {
  /** Does this boot run on the provider that mounts volumes? */
  volumeProvider: boolean;
  /** The project's Volumes flag. */
  volumes: boolean;
  /** The project's Stateless sessions flag (counts only with Volumes on). */
  stateless: boolean;
  /** KORTIX_EPHEMERAL_SANDBOXES=off */
  envVolumeOff: boolean;
}

function isBootMode(v: unknown): v is BootMode {
  return typeof v === 'string' && (BOOT_MODES as readonly string[]).includes(v);
}

/** Which mode a NEW box of this project's session asks for. */
export function resolveBootMode(target: BootModeTarget): BootModeDecision {
  if (!target.volumeProvider) return { mode: 'standard', source: 'provider', standardFallback: true };
  if (!target.volumes) return { mode: 'standard', source: 'volumes_off', standardFallback: true };
  if (!target.stateless) return { mode: 'standard', source: 'project', standardFallback: true };
  if (target.envVolumeOff) {
    return { mode: 'artifacts', source: 'project', standardFallback: true, capped: 'env_volume_off' };
  }
  return { mode: 'volume', source: 'project', standardFallback: true };
}

/**
 * The decision for one session. A session whose state already lives on a
 * volume keeps booting on it when Volumes or Stateless sessions is turned off
 * for its project: never strand a session's files.
 */
export function sessionBootDecision(decision: BootModeDecision, volumeLocked: boolean): BootModeDecision {
  const flagsOff = decision.source === 'volumes_off' || (decision.source === 'project' && decision.mode === 'standard');
  if (volumeLocked && flagsOff) {
    return { mode: 'volume', source: 'session_volume', standardFallback: decision.standardFallback };
  }
  return decision;
}

export type BootModeFailures = Partial<Record<BootMode, number>>;

/**
 * The mode a session boots in after `failures` (per mode, this session).
 * `volumeLocked`: the session's state already lives on a volume, so it never
 * steps off `volume`.
 */
export function modeAfterFailures(
  start: BootMode,
  failures: BootModeFailures,
  standardFallback: boolean,
  volumeLocked = false,
): BootMode {
  let mode = start;
  if (mode === 'volume' && !volumeLocked && (failures.volume ?? 0) >= BOOT_FALLBACK.volumeAttempts) {
    mode = 'artifacts';
  }
  if (mode === 'artifacts' && standardFallback && (failures.artifacts ?? 0) >= BOOT_FALLBACK.artifactsAttempts) {
    mode = 'standard';
  }
  return mode;
}

/** May a failed boot in `mode` be tried again in the same mode? */
export function attemptsLeft(mode: BootMode, failures: BootModeFailures): boolean {
  if (mode === 'volume') return (failures.volume ?? 0) < BOOT_FALLBACK.volumeAttempts;
  if (mode === 'artifacts') return (failures.artifacts ?? 0) < BOOT_FALLBACK.artifactsAttempts;
  return false;
}

/** A short, stable reason code for a fallback, kept on the session's boot record. */
export function bootFailureReason(message: string): string {
  if (/session (state|volume)|KORTIX_PERSIST_ROOT|kss-|storage volume limit|session’s storage/i.test(message)) {
    return 'session_volume';
  }
  if (/boot.?artifacts|kortix-artifacts/i.test(message)) return 'artifacts_volume';
  if (/volume|mount/i.test(message)) return 'volume_mount';
  if (/timed? ?out|timeout|deadline/i.test(message)) return 'timeout';
  if (/never reached|not ready|health|pingable/i.test(message)) return 'boot_health';
  return 'other';
}

/** What a session row remembers about its boots (project_sessions.metadata.bootMode). */
export interface SessionBootRecord {
  requested: BootMode;
  source: BootModeSource;
  /** The mode of the latest attempt (or boot). */
  mode: BootMode;
  failures: BootModeFailures;
  fallbacks: Array<{ from: BootMode; to: BootMode; reason: string; detail: string; at: string }>;
  /** A box of this session booted with its state on the volume. */
  volumeBooted?: boolean;
  bootedAt?: string;
  updatedAt: string;
}

export function parseSessionBootRecord(value: unknown): SessionBootRecord | null {
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object' || !isBootMode(v.mode)) return null;
  const failures: BootModeFailures = {};
  const f = (v.failures ?? {}) as Record<string, unknown>;
  for (const m of BOOT_MODES) {
    const n = Number(f[m]);
    if (Number.isFinite(n) && n > 0) failures[m] = n;
  }
  return {
    requested: isBootMode(v.requested) ? v.requested : v.mode,
    source: (typeof v.source === 'string' ? v.source : 'default') as BootModeSource,
    mode: v.mode,
    failures,
    fallbacks: Array.isArray(v.fallbacks) ? (v.fallbacks as SessionBootRecord['fallbacks']) : [],
    ...(v.volumeBooted === true ? { volumeBooted: true } : {}),
    ...(typeof v.bootedAt === 'string' ? { bootedAt: v.bootedAt } : {}),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date(0).toISOString(),
  };
}
