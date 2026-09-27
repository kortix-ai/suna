/**
 * Instance scoping for BACKGROUND work on a shared database.
 *
 * Local development runs several API instances (worktrees + the primary
 * `pnpm dev`) against ONE Supabase. Prompt-inbox delivery, session-lifecycle
 * commands, env-sync fan-outs and the box reaper read the same tables, so they
 * form one work queue across every running instance. Each instance has its own
 * `KORTIX_URL` (its own quick tunnel): whichever instance dequeues a job pushes
 * ITS gateway URL into the sandbox. When that instance's tunnel is dead the box
 * gets a dead URL, and the OWNING instance's log shows nothing (2026-08-22,
 * twice: `mw-perf` at 20:16 UTC, the primary `pnpm dev` at ~23:00 UTC).
 *
 * The rule: a sandbox is touched by background work ONLY from the instance
 * that provisioned it. `provisionSessionSandbox` stamps
 * `session_sandboxes.metadata.instanceId = config.KORTIX_INSTANCE_ID`; every
 * background path asks this helper before acting on a row.
 *
 * Deployed environments never set `KORTIX_INSTANCE_ID` (one `KORTIX_URL`), so
 * the helper is a strict no-op there. Rows that predate the stamp belong to
 * everyone — the safe direction: never strand a legacy sandbox. Provider BOXES
 * follow a stricter rule: see `providerBoxOwnedByThisInstance`.
 *
 * HTTP-path work (the proxy, `/start`, `prompt_async` through the proxy) is
 * deliberately NOT scoped: the user's browser talks to one stack on purpose.
 */
import { config } from '../config';

export const SANDBOX_INSTANCE_METADATA_KEY = 'instanceId';

/** This instance's id, or undefined when scoping is off (deployed envs). */
export function currentInstanceId(): string | undefined {
  const raw = (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

/**
 * True when background work on this sandbox may run here:
 *  - `KORTIX_INSTANCE_ID` is unset (scoping off), or
 *  - the row carries no `instanceId` (legacy row), or
 *  - the row's `instanceId` equals ours.
 */
export function sandboxBelongsToThisInstance(metadata: unknown): boolean {
  const mine = currentInstanceId();
  if (!mine) return true;
  const theirs = sandboxInstanceId(metadata);
  return theirs === null || theirs === mine;
}

/** The `instanceId` stamped on a sandbox row, or null when absent. */
export function sandboxInstanceId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[SANDBOX_INSTANCE_METADATA_KEY];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** Metadata fragment to merge into a sandbox row at creation. `{}` when scoping is off. */
export function instanceStampMetadata(): Record<string, string> {
  const mine = currentInstanceId();
  return mine ? { [SANDBOX_INSTANCE_METADATA_KEY]: mine } : {};
}

/**
 * The orphan reaper's ownership rule for a PROVIDER box, which is stricter than
 * `sandboxBelongsToThisInstance`.
 *
 * A row lives in this instance's own database, so a legacy row is safe to
 * share. A provider box is not. The orphan reaper stops a listed box that has
 * no row in THIS database, and one provider org and one `kortix.env` tag are
 * shared by deployed dev, every local stack and every PR preview, each with its
 * own database. So a box is this instance's only when its stamp (the provider
 * label `kortix.instance`, or `kortix_instance` on E2B) equals this instance's
 * id, and no id equals no stamp:
 *  - a deployed control plane (no id) owns only unstamped boxes;
 *  - a local or preview stack owns only boxes stamped with its own id.
 *
 * 2026-09-27: a local stack treated unstamped boxes as its own and stopped
 * deployed-dev boxes on every 5-minute pass for at least two days. A turn
 * ended with "The sandbox stopped unexpectedly".
 */
export function providerBoxOwnedByThisInstance(stamp: string | null | undefined): boolean {
  const theirs = typeof stamp === 'string' && stamp !== '' ? stamp : null;
  return theirs === (currentInstanceId() ?? null);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Why the orphan reaper must not run here at all, or null when it may.
 *
 * An instance with no id claims the unstamped boxes. Only a deployed control
 * plane may claim them. A process on a loopback database is a local stack,
 * started without `scripts/dev-local.sh` or a worktree, so it has no id. It
 * shares dev's provider keys and `kortix.env=dev` tag, and its database holds
 * no row for any deployed box.
 */
export function orphanReapRefusal(): string | null {
  if (currentInstanceId()) return null;
  const raw = (config as { DATABASE_URL?: string }).DATABASE_URL;
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  if (!LOOPBACK_HOSTS.has(host) && !host.startsWith('127.')) return null;
  return (
    'no KORTIX_INSTANCE_ID on a loopback database: this local stack cannot prove it owns an ' +
    'unstamped provider box, so the orphan reaper stops nothing. Start it with scripts/dev-local.sh ' +
    'or `pnpm worktree`, which set KORTIX_INSTANCE_ID.'
  );
}
