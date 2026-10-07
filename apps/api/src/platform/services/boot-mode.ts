/**
 * Session boot modes: how a new session box boots, decided in one place.
 *
 *   standard  — the image alone.
 *   artifacts — the image plus the read-only boot-artifacts volume (the
 *               latest runtime: daemon, CLI, OpenCode, managed skills).
 *   volume    — an ephemeral box whose session state lives on its own volume,
 *               plus the artifacts. A stop retires the box (ephemeral-sandbox.ts).
 *
 * The policy is one `kortix.platform_settings` row, edited from the admin
 * console (Admin → Boot modes). Targeting, first match wins:
 *
 *   1. volume provider? Anything else boots `standard` (drive sync still
 *      applies when it is on; that is a drives concern, not a boot mode).
 *   2. the policy's kill switch → `standard` for every new box.
 *   3. a per-organization rule.
 *   4. the project's `ephemeral_sandboxes` flag → `volume` (the older,
 *      per-project switch keeps working).
 *   5. the percentage rollout, bucketed deterministically by organization id.
 *   6. the default rule.
 *
 * `KORTIX_EPHEMERAL_SANDBOXES=off` (env) still stops new volume boxes: a rule
 * that asks for `volume` gets `artifacts`.
 *
 * Fallback: a session whose boots keep failing in one mode steps down
 * volume → artifacts → standard. Failures are counted per session and per mode
 * (on the session row), so a session that degraded stays degraded. The last
 * step can be turned off per rule. A session whose state already lives on a
 * volume never steps off it: booting it without the volume would lose its
 * files.
 *
 * Pure: no database, no config. The store lives in boot-mode-store.ts.
 */
import { createHash } from 'node:crypto';

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
  default: BootModeRule;
  /** Orgs not named in `orgs` whose bucket is below `percent` get this rule. */
  rollout: (BootModeRule & { percent: number }) | null;
  /** Per-organization (account id) rules. */
  orgs: Record<string, BootModeRule>;
  fallback: { volumeAttempts: number; artifactsAttempts: number };
  /** `<volume>@<tag>`; null uses KORTIX_BOOT_ARTIFACTS. */
  artifacts: string | null;
}

export type BootModeSource = 'provider' | 'kill_switch' | 'org' | 'project_flag' | 'rollout' | 'default';

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
  /** The project's own `ephemeral_sandboxes` switch is on. */
  projectVolumeFlag: boolean;
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

/** The policy in effect before anyone saved one: today's env-driven behavior. */
export function defaultBootModePolicy(envArtifactsSet: boolean): BootModePolicy {
  return {
    killSwitch: false,
    default: { mode: envArtifactsSet ? 'artifacts' : 'standard', standardFallback: true },
    rollout: null,
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
  const rolloutRaw = v.rollout as Record<string, unknown> | null | undefined;
  const rolloutRule = parseRule(rolloutRaw, null);
  const percent = clampInt(rolloutRaw?.percent, 0, 100, 0);
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
    killSwitch: v.killSwitch === true,
    default: parseRule(v.default, base.default)!,
    rollout: rolloutRule && percent > 0 ? { ...rolloutRule, percent } : null,
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

/** Which mode a NEW box of this organization's session asks for. */
export function resolveBootMode(policy: BootModePolicy, target: BootModeTarget): BootModeDecision {
  if (!target.volumeProvider) return { mode: 'standard', source: 'provider', standardFallback: true };
  if (policy.killSwitch) return { mode: 'standard', source: 'kill_switch', standardFallback: true };
  let rule: BootModeRule;
  let source: BootModeSource;
  const org = policy.orgs[target.accountId.toLowerCase()];
  if (org) {
    rule = org;
    source = 'org';
  } else if (target.projectVolumeFlag) {
    rule = { mode: 'volume', standardFallback: policy.default.standardFallback };
    source = 'project_flag';
  } else if (policy.rollout && rolloutBucket(target.accountId) < policy.rollout.percent) {
    rule = policy.rollout;
    source = 'rollout';
  } else {
    rule = policy.default;
    source = 'default';
  }
  if (rule.mode === 'volume' && target.envVolumeOff) {
    return { mode: 'artifacts', source, standardFallback: rule.standardFallback, capped: 'env_volume_off' };
  }
  return { mode: rule.mode, source, standardFallback: rule.standardFallback };
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
