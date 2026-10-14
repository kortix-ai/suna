/**
 * How a new session box boots, decided in one place.
 *
 * The project's `volumes` flag gates everything built on volumes: Files over
 * the project drive, drive mounts and sync, session volumes (ephemeral boxes),
 * boot artifacts and persistent machines. Off, the project sees the product as
 * it was before volumes: Files is the repo browser and sessions boot from the
 * image alone. Both switches are per project feature flags
 * (feature-flags/registry.ts); nothing here is set per organization.
 *
 * Boot modes, for a project with Volumes on:
 *
 *   standard  — the image alone.
 *   artifacts — the image plus the read-only boot-artifacts volume (the
 *               latest runtime: daemon, CLI, OpenCode, managed skills).
 *   volume    — an ephemeral box whose session state lives on its own volume,
 *               plus the artifacts. A stop retires the box (ephemeral-sandbox.ts).
 *
 *   1. volume provider? Anything else boots `standard`.
 *   2. Volumes off for the project → `standard`.
 *   3. the policy's kill switch → `standard` for every new box.
 *   4. the project's `stateless_sessions` flag → `volume`.
 *   5. the default rule (`standard` or `artifacts`, Admin → Volumes).
 *
 * A session whose state already lives on a volume keeps it whatever the
 * switch says (session-sandbox.ts): booting it without the volume would lose
 * its files.
 *
 * Operator emergency overrides (env, not the product switch):
 * `KORTIX_EPHEMERAL_SANDBOXES=off` stops new volume boxes (a stateless project
 * gets `artifacts`); `KORTIX_DRIVES_SESSION_MOUNT=off` boots sessions without
 * drive mounts.
 *
 * Fallback: a session whose boots keep failing in one mode steps down
 * volume → artifacts → standard. Failures are counted per session and per mode
 * (on the session row), so a session that degraded stays degraded. The last
 * step can be turned off. A session whose state already lives on a volume
 * never steps off it.
 *
 * The policy is one `kortix.platform_settings` row (`session_boot_modes`),
 * edited from Admin → Volumes. Pure: no database, no config. The store lives
 * in boot-mode-setting.ts and boot-mode-store.ts.
 */
export const BOOT_MODES = ['standard', 'artifacts', 'volume'] as const;
export type BootMode = (typeof BOOT_MODES)[number];

export interface BootModeRule {
  mode: BootMode;
  /** After the artifacts attempts are spent, try the image alone. */
  standardFallback: boolean;
}

export interface BootModePolicy {
  /** Forces `standard` for every new box. */
  killSwitch: boolean;
  /** The boot mode of a project with Volumes on and Stateless sessions off. */
  default: BootModeRule;
  fallback: { volumeAttempts: number; artifactsAttempts: number };
  /** `<volume>@<tag>`; null uses KORTIX_BOOT_ARTIFACTS. */
  artifacts: string | null;
}

/** `project`: the project's Stateless sessions flag. Records written before 2026-10-13 may say `org`. */
export type BootModeSource = 'provider' | 'volumes_off' | 'kill_switch' | 'project' | 'default' | 'session_volume';

export interface BootModeDecision {
  mode: BootMode;
  source: BootModeSource;
  standardFallback: boolean;
  /** Set when the env switch turned a `volume` rule into `artifacts`. */
  capped?: 'env_volume_off';
}

export interface BootModeTarget {
  /** The project's `volumes` flag. */
  volumes: boolean;
  /** The project's `stateless_sessions` flag. */
  stateless: boolean;
  /** Does this boot run on the provider that mounts volumes? */
  volumeProvider: boolean;
  /** KORTIX_EPHEMERAL_SANDBOXES=off */
  envVolumeOff: boolean;
}

export const DEFAULT_FALLBACK_ATTEMPTS = 2;

function isBootMode(v: unknown): v is BootMode {
  return typeof v === 'string' && (BOOT_MODES as readonly string[]).includes(v);
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseRule(v: unknown, dflt: BootModeRule | null): BootModeRule | null {
  const r = v as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object' || !isBootMode(r.mode)) return dflt;
  return { mode: r.mode, standardFallback: r.standardFallback !== false };
}

/**
 * The policy in effect before anyone saved one: `standard` boot for a project
 * with Volumes on. Stateless (`volume`) boot is the project's own flag.
 */
export function defaultBootModePolicy(_envArtifactsSet = false): BootModePolicy {
  return {
    killSwitch: false,
    default: { mode: 'standard', standardFallback: true },
    fallback: { volumeAttempts: DEFAULT_FALLBACK_ATTEMPTS, artifactsAttempts: DEFAULT_FALLBACK_ATTEMPTS },
    artifacts: null,
  };
}

/**
 * The default rule never boots on a volume: turning Volumes on must not make
 * sessions stateless. Volume boot comes only from the project's Stateless
 * sessions flag, so a stored `default: volume` reads as `standard`.
 */
function defaultRule(rule: BootModeRule): BootModeRule {
  return rule.mode === 'volume' ? { ...rule, mode: 'standard' } : rule;
}

/**
 * Stored JSON → policy. Garbage fields fall back to the defaults; never throws.
 * The per-organization fields a row saved before 2026-10-13 holds (`volumes`,
 * `orgs`) are dropped: Volumes is a project flag.
 */
export function parseBootModePolicy(value: unknown, envArtifactsSet: boolean): BootModePolicy {
  const base = defaultBootModePolicy(envArtifactsSet);
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object') return base;
  const fb = (v.fallback ?? {}) as Record<string, unknown>;
  const artifacts = typeof v.artifacts === 'string' && v.artifacts.trim() ? v.artifacts.trim() : null;
  return {
    killSwitch: v.killSwitch === true,
    default: defaultRule(parseRule(v.default, base.default)!),
    fallback: {
      volumeAttempts: clampInt(fb.volumeAttempts, 1, 10, DEFAULT_FALLBACK_ATTEMPTS),
      artifactsAttempts: clampInt(fb.artifactsAttempts, 1, 10, DEFAULT_FALLBACK_ATTEMPTS),
    },
    artifacts,
  };
}

/** Which mode a NEW box of this project's session asks for. */
export function resolveBootMode(policy: BootModePolicy, target: BootModeTarget): BootModeDecision {
  if (!target.volumeProvider) return { mode: 'standard', source: 'provider', standardFallback: true };
  if (!target.volumes) return { mode: 'standard', source: 'volumes_off', standardFallback: true };
  if (policy.killSwitch) return { mode: 'standard', source: 'kill_switch', standardFallback: true };
  if (target.stateless) {
    const standardFallback = policy.default.standardFallback;
    if (target.envVolumeOff) return { mode: 'artifacts', source: 'project', standardFallback, capped: 'env_volume_off' };
    return { mode: 'volume', source: 'project', standardFallback };
  }
  return { mode: policy.default.mode, source: 'default', standardFallback: policy.default.standardFallback };
}

/**
 * The decision for one session. A session whose state already lives on a
 * volume keeps booting on it when Volumes is turned off for its project:
 * never strand a session's files.
 */
export function sessionBootDecision(decision: BootModeDecision, volumeLocked: boolean): BootModeDecision {
  if (volumeLocked && decision.source === 'volumes_off') {
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
  policy: Pick<BootModePolicy, 'fallback'>,
  standardFallback: boolean,
  volumeLocked = false,
): BootMode {
  let mode = start;
  if (mode === 'volume' && !volumeLocked && (failures.volume ?? 0) >= policy.fallback.volumeAttempts) {
    mode = 'artifacts';
  }
  if (mode === 'artifacts' && standardFallback && (failures.artifacts ?? 0) >= policy.fallback.artifactsAttempts) {
    mode = 'standard';
  }
  return mode;
}

/** May a failed boot in `mode` be tried again in the same mode? */
export function attemptsLeft(mode: BootMode, failures: BootModeFailures, policy: Pick<BootModePolicy, 'fallback'>): boolean {
  if (mode === 'volume') return (failures.volume ?? 0) < policy.fallback.volumeAttempts;
  if (mode === 'artifacts') return (failures.artifacts ?? 0) < policy.fallback.artifactsAttempts;
  return false;
}

/** A short, stable reason code for the admin console's fallback counts. */
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
