/**
 * Volumes: the one switch for the whole volumes feature, and how a new session
 * box boots, decided in one place.
 *
 * Volumes (per organization) gates everything built on volumes: Files over the
 * project drive, drive mounts and sync, session volumes (ephemeral boxes), boot
 * artifacts and persistent machines. Off, an organization sees the product as
 * it was before volumes: Files is the repo browser and sessions boot from the
 * image alone. Targeting, first match wins:
 *
 *   1. a per-organization on/off.
 *   2. the global switch.
 *   3. the percentage rollout, bucketed deterministically by organization id.
 *   4. off.
 *
 * Boot modes, for an organization with Volumes on:
 *
 *   standard  — the image alone.
 *   artifacts — the image plus the read-only boot-artifacts volume (the
 *               latest runtime: daemon, CLI, OpenCode, managed skills).
 *   volume    — an ephemeral box whose session state lives on its own volume,
 *               plus the artifacts. A stop retires the box (ephemeral-sandbox.ts).
 *
 *   1. volume provider? Anything else boots `standard`.
 *   2. Volumes off for the organization → `standard`.
 *   3. the policy's kill switch → `standard` for every new box.
 *   4. a per-organization mode rule.
 *   5. the default rule (`volume` until an admin picks another).
 *
 * A session whose state already lives on a volume keeps it whatever the
 * switch says (session-sandbox.ts): booting it without the volume would lose
 * its files.
 *
 * Operator emergency overrides (env, not the product switch):
 * `KORTIX_EPHEMERAL_SANDBOXES=off` stops new volume boxes (a rule that asks for
 * `volume` gets `artifacts`); `KORTIX_DRIVES_SESSION_MOUNT=off` boots sessions
 * without drive mounts.
 *
 * Fallback: a session whose boots keep failing in one mode steps down
 * volume → artifacts → standard. Failures are counted per session and per mode
 * (on the session row), so a session that degraded stays degraded. The last
 * step can be turned off per rule. A session whose state already lives on a
 * volume never steps off it.
 *
 * The policy is one `kortix.platform_settings` row (`session_boot_modes`),
 * edited from Admin → Volumes. Pure: no database, no config. The store lives
 * in boot-mode-setting.ts and boot-mode-store.ts.
 */
import { createHash } from 'node:crypto';

export const BOOT_MODES = ['standard', 'artifacts', 'volume'] as const;
export type BootMode = (typeof BOOT_MODES)[number];

export interface BootModeRule {
  mode: BootMode;
  /** After the artifacts attempts are spent, try the image alone. */
  standardFallback: boolean;
}

/** The Volumes master switch. */
export interface VolumesPolicy {
  /** On for every organization without an explicit off. */
  enabled: boolean;
  /** With the global switch off: organizations whose bucket is below this get Volumes. */
  percent: number;
  /** Per-organization (account id) on/off; wins over the global switch and the rollout. */
  orgs: Record<string, boolean>;
}

export interface BootModePolicy {
  volumes: VolumesPolicy;
  /** Forces `standard` for every new box. */
  killSwitch: boolean;
  /** The boot mode of an organization with Volumes on and no rule of its own. */
  default: BootModeRule;
  /** Per-organization (account id) boot mode rules. */
  orgs: Record<string, BootModeRule>;
  fallback: { volumeAttempts: number; artifactsAttempts: number };
  /** `<volume>@<tag>`; null uses KORTIX_BOOT_ARTIFACTS. */
  artifacts: string | null;
}

export type BootModeSource = 'provider' | 'volumes_off' | 'kill_switch' | 'org' | 'default' | 'session_volume';

export type VolumesSource = 'org' | 'global' | 'rollout' | 'off';

export interface VolumesDecision {
  enabled: boolean;
  source: VolumesSource;
}

export interface BootModeDecision {
  mode: BootMode;
  source: BootModeSource;
  standardFallback: boolean;
  /** Set when the env switch turned a `volume` rule into `artifacts`. */
  capped?: 'env_volume_off';
}

export interface BootModeTarget {
  accountId: string;
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
 * The policy in effect before anyone saved one: Volumes off for everyone, and
 * `volume` (with fallback) for an organization once it is turned on.
 */
export function defaultBootModePolicy(_envArtifactsSet = false): BootModePolicy {
  return {
    volumes: { enabled: false, percent: 0, orgs: {} },
    killSwitch: false,
    default: { mode: 'volume', standardFallback: true },
    orgs: {},
    fallback: { volumeAttempts: DEFAULT_FALLBACK_ATTEMPTS, artifactsAttempts: DEFAULT_FALLBACK_ATTEMPTS },
    artifacts: null,
  };
}

/** Stored JSON → policy. Garbage fields fall back to the defaults; never throws. */
export function parseBootModePolicy(value: unknown, envArtifactsSet: boolean): BootModePolicy {
  const base = defaultBootModePolicy(envArtifactsSet);
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object') return base;
  const vol = (v.volumes ?? {}) as Record<string, unknown>;
  const volumeOrgs: Record<string, boolean> = {};
  if (vol.orgs && typeof vol.orgs === 'object') {
    for (const [id, on] of Object.entries(vol.orgs as Record<string, unknown>)) {
      if (typeof on === 'boolean' && /^[0-9a-f-]{36}$/i.test(id)) volumeOrgs[id.toLowerCase()] = on;
    }
  }
  const orgs: Record<string, BootModeRule> = {};
  if (v.orgs && typeof v.orgs === 'object') {
    for (const [id, rule] of Object.entries(v.orgs as Record<string, unknown>)) {
      const parsed = parseRule(rule, null);
      if (parsed && /^[0-9a-f-]{36}$/i.test(id)) orgs[id.toLowerCase()] = parsed;
    }
  }
  const fb = (v.fallback ?? {}) as Record<string, unknown>;
  const artifacts = typeof v.artifacts === 'string' && v.artifacts.trim() ? v.artifacts.trim() : null;
  return {
    volumes: { enabled: vol.enabled === true, percent: clampInt(vol.percent, 0, 100, 0), orgs: volumeOrgs },
    killSwitch: v.killSwitch === true,
    default: parseRule(v.default, base.default)!,
    orgs,
    fallback: {
      volumeAttempts: clampInt(fb.volumeAttempts, 1, 10, DEFAULT_FALLBACK_ATTEMPTS),
      artifactsAttempts: clampInt(fb.artifactsAttempts, 1, 10, DEFAULT_FALLBACK_ATTEMPTS),
    },
    artifacts,
  };
}

/** 0..99, stable for an organization id across processes and releases. */
export function rolloutBucket(accountId: string): number {
  const digest = createHash('sha256').update(`boot-mode:${accountId.toLowerCase()}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/** Is Volumes on for this organization? */
export function resolveVolumes(policy: Pick<BootModePolicy, 'volumes'>, accountId: string | null | undefined): VolumesDecision {
  const id = (accountId ?? '').toLowerCase();
  if (!id) return { enabled: false, source: 'off' };
  const explicit = policy.volumes.orgs[id];
  if (typeof explicit === 'boolean') return { enabled: explicit, source: explicit ? 'org' : 'off' };
  if (policy.volumes.enabled) return { enabled: true, source: 'global' };
  if (policy.volumes.percent > 0 && rolloutBucket(id) < policy.volumes.percent) return { enabled: true, source: 'rollout' };
  return { enabled: false, source: 'off' };
}

/** Which mode a NEW box of this organization's session asks for. */
export function resolveBootMode(policy: BootModePolicy, target: BootModeTarget): BootModeDecision {
  if (!target.volumeProvider) return { mode: 'standard', source: 'provider', standardFallback: true };
  if (!resolveVolumes(policy, target.accountId).enabled) {
    return { mode: 'standard', source: 'volumes_off', standardFallback: true };
  }
  if (policy.killSwitch) return { mode: 'standard', source: 'kill_switch', standardFallback: true };
  const org = policy.orgs[target.accountId.toLowerCase()];
  const rule: BootModeRule = org ?? policy.default;
  const source: BootModeSource = org ? 'org' : 'default';
  if (rule.mode === 'volume' && target.envVolumeOff) {
    return { mode: 'artifacts', source, standardFallback: rule.standardFallback, capped: 'env_volume_off' };
  }
  return { mode: rule.mode, source, standardFallback: rule.standardFallback };
}

/**
 * The decision for one session. A session whose state already lives on a
 * volume keeps booting on it when Volumes is turned off for its organization:
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
