/**
 * Session boxes that preview stacks leave running on the shared Platinum org.
 *
 * Every preview stack runs its own API and database, and each API creates one
 * Platinum box per session with the metadata `kortix.env=preview`,
 * `kortix.workload=session`. On 2026-09-23 87 of them (4 GB each, 348 GB) sat
 * idle for hours and filled the org's 524288 MB RAM pool. Every preview deploy
 * and every preview session then failed with `429 org resource pool
 * exhausted`, and so did dev, which shares the org.
 *
 * The API stamps each session box with `kortix.instance=<host sandbox name>`
 * (see previewWorkerEnvironment() in preview-stack.ts). This module decides,
 * from a provider listing alone, which session boxes to stop:
 *
 *   - teardown: every running session box owned by the host being deleted.
 *     Its database dies with the host, so nothing can ever resume the box.
 *   - sweep: every running session box whose owning host no longer exists, and
 *     every running session box idle longer than the idle limit, tagged or not.
 *
 * Two guards hold in every path. A box qualifies only when its metadata says
 * `kortix.managed=true`, `kortix.env=preview` and `kortix.workload=session`, so
 * dev, staging and production boxes are never selected. A host sandbox
 * (`kortix-preview-pr-*`, `kortix-env-*`, or any box with an `owner`) is never
 * selected: hosts belong to the preview lifecycle, not to this sweep.
 *
 * Selection STOPS a box. It never deletes one. A stop is reversible and frees
 * the RAM reservation, which is the resource that ran out.
 */

export interface PlatinumListedSandbox {
  id: string;
  name?: string;
  state?: string;
  ramMb?: number;
  createdAt?: string | null;
  startedAt?: string | null;
  lastActivityAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export const PREVIEW_HOST_OWNERS = ['kortix-preview', 'kortix-branch-env'] as const;

/** Default idle limit for the sweep. Well above the 60 min provider backstop. */
export const PREVIEW_SESSION_MAX_IDLE_MS = 6 * 60 * 60_000;

/**
 * Default size of the org RAM pool, from the provider's own refusal:
 * `524288/524288 MB RAM in use`. Platinum exposes no endpoint for it.
 */
export const PLATINUM_POOL_MB_DEFAULT = 524_288;

/** RAM a preview host reserves (deployPlatinumPreview creates it with 16384 MB). */
export const PREVIEW_HOST_RAM_MB = 16_384;

function meta(sandbox: PlatinumListedSandbox, key: string): string {
  const value = sandbox.metadata?.[key];
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function isRunning(sandbox: PlatinumListedSandbox): boolean {
  return String(sandbox.state ?? '').toLowerCase() === 'running';
}

export function isPreviewHostSandbox(sandbox: PlatinumListedSandbox): boolean {
  const owner = meta(sandbox, 'owner');
  if ((PREVIEW_HOST_OWNERS as readonly string[]).includes(owner)) return true;
  const name = sandbox.name ?? '';
  return name.startsWith('kortix-preview-pr-') || name.startsWith('kortix-env-');
}

/** A session box a preview API created, and nothing else. */
export function isPreviewSessionSandbox(sandbox: PlatinumListedSandbox): boolean {
  if (isPreviewHostSandbox(sandbox)) return false;
  if (meta(sandbox, 'owner') !== '') return false;
  return (
    meta(sandbox, 'kortix.managed') === 'true' &&
    meta(sandbox, 'kortix.env') === 'preview' &&
    meta(sandbox, 'kortix.workload') === 'session'
  );
}

/** The host sandbox name a session box belongs to, or null for an untagged box. */
export function previewSessionOwner(sandbox: PlatinumListedSandbox): string | null {
  const owner = meta(sandbox, 'kortix.instance');
  return owner === '' ? null : owner;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The newest evidence that the box was in use. `null` when the listing carries
 * no parseable time: such a box is never judged idle.
 */
export function lastUsedAtMs(sandbox: PlatinumListedSandbox): number | null {
  const times = [sandbox.lastActivityAt, sandbox.startedAt, sandbox.createdAt]
    .map(timestamp)
    .filter((value): value is number => value !== null);
  return times.length === 0 ? null : Math.max(...times);
}

/** Running session boxes that belong to the host being torn down. */
export function selectPreviewSessionsForTeardown(
  sandboxes: readonly PlatinumListedSandbox[],
  hostNames: readonly string[],
): string[] {
  const owners = new Set(hostNames.filter((name) => name !== ''));
  if (owners.size === 0) return [];
  return sandboxes
    .filter(
      (sandbox) =>
        isRunning(sandbox) &&
        isPreviewSessionSandbox(sandbox) &&
        owners.has(previewSessionOwner(sandbox) ?? ''),
    )
    .map((sandbox) => sandbox.id);
}

export type PreviewSessionStopReason = 'owner-gone' | 'idle';

export interface PreviewSessionStop {
  id: string;
  owner: string | null;
  reason: PreviewSessionStopReason;
  idleMinutes: number | null;
}

/**
 * Running session boxes the sweep stops.
 *
 * `liveHostNames` is the set of host sandbox names that still exist. A tagged
 * box whose owner is absent from it has no database behind it and no way to be
 * resumed. An untagged box (created before the tag existed) cannot be matched
 * to an owner, so only the idle limit applies to it.
 */
export function selectStalePreviewSessions(
  sandboxes: readonly PlatinumListedSandbox[],
  input: { liveHostNames: ReadonlySet<string>; nowMs: number; maxIdleMs?: number },
): PreviewSessionStop[] {
  const maxIdleMs = input.maxIdleMs ?? PREVIEW_SESSION_MAX_IDLE_MS;
  const stops: PreviewSessionStop[] = [];
  for (const sandbox of sandboxes) {
    if (!isRunning(sandbox) || !isPreviewSessionSandbox(sandbox)) continue;
    const owner = previewSessionOwner(sandbox);
    const usedAt = lastUsedAtMs(sandbox);
    const idleMinutes = usedAt === null ? null : Math.floor((input.nowMs - usedAt) / 60_000);
    if (owner !== null && !input.liveHostNames.has(owner)) {
      stops.push({ id: sandbox.id, owner, reason: 'owner-gone', idleMinutes });
      continue;
    }
    if (usedAt !== null && input.nowMs - usedAt > maxIdleMs) {
      stops.push({ id: sandbox.id, owner, reason: 'idle', idleMinutes });
    }
  }
  return stops;
}

/** Names of every preview host sandbox in the listing, in any state. */
export function previewHostNames(sandboxes: readonly PlatinumListedSandbox[]): Set<string> {
  return new Set(
    sandboxes
      .filter((sandbox) => isPreviewHostSandbox(sandbox) && sandbox.name)
      .map((sandbox) => sandbox.name as string),
  );
}

export interface PoolConsumer {
  label: string;
  count: number;
  ramMb: number;
}

export interface PoolUsage {
  poolMb: number;
  usedMb: number;
  freeMb: number;
  running: number;
  consumers: PoolConsumer[];
}

/** One group per kind of running box, so a report names who holds the pool. */
function consumerLabel(sandbox: PlatinumListedSandbox): string {
  if (isPreviewHostSandbox(sandbox)) return `preview host ${sandbox.name ?? sandbox.id}`;
  const env = meta(sandbox, 'kortix.env') || 'untagged';
  const workload = meta(sandbox, 'kortix.workload') || 'unknown';
  if (isPreviewSessionSandbox(sandbox)) {
    return `preview sessions of ${previewSessionOwner(sandbox) ?? 'an untagged preview'}`;
  }
  return `${env} ${workload} boxes`;
}

export function summarizePoolUsage(
  sandboxes: readonly PlatinumListedSandbox[],
  poolMb: number = PLATINUM_POOL_MB_DEFAULT,
): PoolUsage {
  const groups = new Map<string, PoolConsumer>();
  let usedMb = 0;
  let running = 0;
  for (const sandbox of sandboxes) {
    if (!isRunning(sandbox)) continue;
    const ramMb = Number.isFinite(sandbox.ramMb) ? Number(sandbox.ramMb) : 0;
    usedMb += ramMb;
    running += 1;
    const label = consumerLabel(sandbox);
    const group = groups.get(label) ?? { label, count: 0, ramMb: 0 };
    group.count += 1;
    group.ramMb += ramMb;
    groups.set(label, group);
  }
  const consumers = [...groups.values()].sort(
    (left, right) => right.ramMb - left.ramMb || left.label.localeCompare(right.label),
  );
  return { poolMb, usedMb, freeMb: poolMb - usedMb, running, consumers };
}

export function formatPoolUsage(usage: PoolUsage, top = 5): string {
  const gb = (mb: number) => `${(mb / 1024).toFixed(0)} GB`;
  const head = `Platinum pool: ${gb(usage.usedMb)} of ${gb(usage.poolMb)} RAM in use by ${usage.running} running boxes, ${gb(Math.max(0, usage.freeMb))} free`;
  const rows = usage.consumers
    .slice(0, top)
    .map((consumer) => `  ${gb(consumer.ramMb)}  ${consumer.count} x ${consumer.label}`);
  return [head, 'top consumers:', ...rows].join('\n');
}

/**
 * True when the org has no room for `neededMb` more. The pool size is a
 * configured constant, so a wrong value can only produce a false refusal
 * message, never a stop.
 */
export function poolCannotFit(usage: PoolUsage, neededMb: number): boolean {
  return neededMb > 0 && usage.freeMb < neededMb;
}
