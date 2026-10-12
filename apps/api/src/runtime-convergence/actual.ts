import { isRecord } from '@kortix/shared/guards';
/**
 * The box's ACTUAL runtime document — parsed from the daemon's health
 * `runtime_truth` block. Spec: the runtime-convergence contract (PR #7785), Rule 1.
 *
 * A parallel branch adds `runtime_truth` to `GET /kortix/health` on the daemon
 * side. Every box that exists TODAY predates it, so parsing is total and
 * tolerant by construction: a missing key, a wrong type, or the field absent
 * entirely all answer "this box reports nothing" rather than throwing —
 * exactly like `parseDaemonRuntimeReport` (runtime-assets/daemon-runtime-report.ts)
 * treats a daemon that predates ITS block. `unknown` is a diff, not a pass
 * (Rule 1): a box that never reports a component is never read as current for
 * it — see `diffRuntime` (./diff.ts), which is where that rule is enforced.
 */

export type RuntimeComponentState = 'current' | 'converging' | 'blocked' | 'unknown';

export interface RuntimeComponentReport {
  state: RuntimeComponentState;
  attempted_at: string | null;
  attempts: number;
  cause: string | null;
}

export interface ActualRuntimeDocument {
  release_id: string | null;
  catalog_fingerprint: string | null;
  /** The daemon may report this as a number or a string; kept as reported. */
  daemon_build: string | number | null;
  cli_sha256: string | null;
  managed_skills_hash: string | null;
  /** Keyed however the daemon names its components. Empty for a box that predates this. */
  components: Record<string, RuntimeComponentReport>;
}

/** Every field unknown/empty — a box that reports nothing at all. */
export const UNREPORTED_ACTUAL_RUNTIME: ActualRuntimeDocument = {
  release_id: null,
  catalog_fingerprint: null,
  daemon_build: null,
  cli_sha256: null,
  managed_skills_hash: null,
  components: {},
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildOrNull(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

const COMPONENT_STATES = new Set<RuntimeComponentState>([
  'current',
  'converging',
  'blocked',
  'unknown',
]);

function parseComponentState(value: unknown): RuntimeComponentState {
  return typeof value === 'string' && COMPONENT_STATES.has(value as RuntimeComponentState)
    ? (value as RuntimeComponentState)
    : 'unknown';
}

function parseAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function parseComponent(value: unknown): RuntimeComponentReport {
  if (!isRecord(value)) {
    return { state: 'unknown', attempted_at: null, attempts: 0, cause: null };
  }
  return {
    state: parseComponentState(value.state),
    attempted_at: str(value.attempted_at),
    attempts: parseAttempts(value.attempts),
    cause: str(value.cause),
  };
}

function parseComponents(value: unknown): Record<string, RuntimeComponentReport> {
  if (!isRecord(value)) return {};
  const out: Record<string, RuntimeComponentReport> = {};
  for (const [name, component] of Object.entries(value)) {
    out[name] = parseComponent(component);
  }
  return out;
}

/**
 * Parse the health `runtime_truth` block. Total: never throws, and a box that
 * does not report the key at all (every box today) returns
 * {@link UNREPORTED_ACTUAL_RUNTIME} — five `unknown` fields, not a crash and
 * not a pass.
 */
export function parseActualRuntime(value: unknown): ActualRuntimeDocument {
  if (!isRecord(value)) return UNREPORTED_ACTUAL_RUNTIME;
  return {
    release_id: str(value.release_id),
    catalog_fingerprint: str(value.catalog_fingerprint),
    daemon_build: buildOrNull(value.daemon_build),
    cli_sha256: str(value.cli_sha256),
    managed_skills_hash: str(value.managed_skills_hash),
    components: parseComponents(value.components),
  };
}
