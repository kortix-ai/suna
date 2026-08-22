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
 * everyone — the safe direction: never strand a legacy sandbox.
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
