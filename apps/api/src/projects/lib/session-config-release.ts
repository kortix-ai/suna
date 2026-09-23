/**
 * The daemon side of config releases, as the API reads it
 * (docs/specs/config-releases.md, "Capability gate", "Health", "Converge
 * response", "`GET /config`, extended").
 *
 * Pure parsing and mapping only. The HTTP calls live in `session-reload.ts`.
 */

/** A daemon that lists this in `/kortix/health` `capabilities` serves `POST /kortix/config/converge`. */
export const CONFIG_RELEASE_CAPABILITY = 'config.release.v1';

/**
 * Always `follow-base`. A session runs the base branch's CURRENT config
 * release; `/workspace` is an editable clone, never a config source. One
 * member on purpose (docs/specs/config-releases.md, "Feature flag").
 */
export type ConfigReleaseMode = 'follow-base';
/** The fallback chain: the desired release, the last proven one, the image default. */
export type ConfigReleaseSource = 'release' | 'image-default';
export type ConvergeOutcome = 'applied' | 'unchanged' | 'declined' | 'quarantined' | 'failed';

const CONVERGE_OUTCOMES: readonly ConvergeOutcome[] = [
  'applied',
  'unchanged',
  'declined',
  'quarantined',
  'failed',
];

/** The health `config` block. The converge response carries the same object. */
export interface DaemonConfigReport {
  release_id: string | null;
  desired_release_id: string | null;
  source: ConfigReleaseSource;
  /** Null before the daemon's first convergence. */
  mode: ConfigReleaseMode | null;
  proven: boolean;
  fallback_reason: string | null;
  failed_release_id: string | null;
}

export interface DaemonConvergeResponse {
  ok: boolean;
  outcome: ConvergeOutcome;
  config: DaemonConfigReport;
  reload: { how: 'restarted'; turn_ended: boolean | null } | null;
  /** Why the release did not apply. Not in the spec's example; the daemon sends it. */
  reason: string | null;
}

/**
 * The `release` object of `GET /config` and of the reload result. Identical
 * to `SessionConfigRelease` in `@kortix/sdk`.
 */
export interface SessionConfigRelease {
  mode: ConfigReleaseMode;
  source: ConfigReleaseSource;
  running_release_id: string | null;
  desired_release_id: string | null;
  proven: boolean;
  fallback_reason: string | null;
  failed_release_id: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

function releaseIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && HEX64.test(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 2_000) : null;
}

export function hasConfigReleaseCapability(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes(CONFIG_RELEASE_CAPABILITY);
}

/** Parse the health `config` block. Null when absent or not an object. */
export function parseDaemonConfigReport(value: unknown): DaemonConfigReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  // `workspace` is not a source any more. A daemon that still reports it is
  // running its /workspace checkout, which under config releases means the
  // chain fell past every release: read it as the image default.
  const source: ConfigReleaseSource = raw.source === 'release' ? 'release' : 'image-default';
  const mode: ConfigReleaseMode | null = raw.mode === 'follow-base' ? 'follow-base' : null;
  return {
    release_id: releaseIdOrNull(raw.release_id),
    desired_release_id: releaseIdOrNull(raw.desired_release_id),
    source,
    mode,
    proven: raw.proven === true,
    fallback_reason: textOrNull(raw.fallback_reason),
    failed_release_id: releaseIdOrNull(raw.failed_release_id),
  };
}

/** Parse `POST /kortix/config/converge`. Null when the body is not a converge response. */
export function parseConvergeResponse(value: unknown): DaemonConvergeResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const outcome = CONVERGE_OUTCOMES.find((candidate) => candidate === raw.outcome);
  const config = parseDaemonConfigReport(raw.config);
  if (!outcome || !config) return null;
  const reload = raw.reload as { how?: unknown; turn_ended?: unknown } | null | undefined;
  return {
    ok: raw.ok === true,
    outcome,
    config,
    reload:
      reload && typeof reload === 'object' && reload.how === 'restarted'
        ? { how: 'restarted', turn_ended: typeof reload.turn_ended === 'boolean' ? reload.turn_ended : null }
        : null,
    reason: textOrNull(raw.reason),
  };
}

/**
 * The response `release` object from the daemon's report.
 *
 * `desired_release_id` is the API's own assignment when the caller computed
 * one (`GET /config`), else the daemon's copy of the last descriptor it
 * fetched. A daemon that has not converged yet reports `mode: null`; the API
 * reports `follow-base`, the only mode there is.
 */
export function toSessionConfigRelease(
  report: DaemonConfigReport,
  desiredReleaseId: string | null | undefined = undefined,
): SessionConfigRelease {
  return {
    mode: report.mode ?? 'follow-base',
    source: report.source,
    running_release_id: report.release_id,
    desired_release_id: desiredReleaseId === undefined ? report.desired_release_id : desiredReleaseId,
    proven: report.proven,
    fallback_reason: report.fallback_reason,
    failed_release_id: report.failed_release_id,
  };
}

/**
 * `stale` for a capable daemon: `running_release_id !== desired_release_id`.
 * Tri-state: null when the desired release is unknown (the API could not
 * build it) or neither side has a release. Never false by default.
 */
export function isReleaseStale(release: SessionConfigRelease, desiredKnown: boolean): boolean | null {
  if (!desiredKnown) return null;
  if (release.running_release_id === null && release.desired_release_id === null) return null;
  return release.running_release_id !== release.desired_release_id;
}
