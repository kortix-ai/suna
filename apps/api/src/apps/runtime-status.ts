/**
 * The status writes of an App runtime (`app_runtimes.status`).
 *
 * Fifteen writers in five files used to write the status `WHERE runtime_id = ?`
 * after an earlier read. Two leases that do not see each other (the idle
 * reaper's `stopping` claim and the public proxy's wake lease) and a removal
 * raced them: a deleted runtime went back to `running` and reopened its
 * compute meter, and the reaper's final `stopped` landed over a box a wake had
 * just started. Each write is now a named transition, one compare-and-set
 * (`shared/status-transition.ts`). `deleted` is terminal.
 */

import { appRuntimes } from '@kortix/db';
import type { SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

import { db } from '../shared/db';
import { type StatusExecutor, type StatusRule, transitionStatus, transitionStatusAll } from '../shared/status-transition';

type RuntimeRow = typeof appRuntimes.$inferSelect;
type RuntimeStatus = 'provisioning' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error' | 'deleted';

const NOT_DELETED: readonly RuntimeStatus[] = ['provisioning', 'starting', 'running', 'stopping', 'stopped', 'error'];

export const APP_RUNTIME_TRANSITIONS = {
  /**
   * The provider confirmed the box ready: a boot, an immediate rollout. A
   * runtime that a stop, an idle stop or a removal moved meanwhile stays put.
   */
  ready: { from: ['provisioning', 'starting', 'running', 'error'], to: 'running' },
  /** The idle reaper claims a running box. */
  claimIdleStop: { from: ['running'], to: 'stopping' },
  /** The idle reaper's stop finished: only its own claim. A wake that leased the row meanwhile wins. */
  finishIdleStop: { from: ['stopping'], to: 'stopped' },
  /** An idle-stop claim that went stale or failed goes back to `running`. */
  releaseIdleStop: { from: ['stopping'], to: 'running' },
  /** A deliberate stop: a person, the cost check, `stopInstance`, a wake that gave up. */
  stop: { from: NOT_DELETED, to: 'stopped' },
  /** The keep-alive found the provider box gone under a row that reads `running`. */
  lost: { from: ['running'], to: 'stopped' },
  /** The public proxy leases a wake. Never a row the idle reaper is stopping, never a deleted one. */
  wake: { from: ['provisioning', 'starting', 'running', 'stopped', 'error'], to: 'starting' },
  /** The wake's provider start finished, under the wake lease. */
  wakeReady: { from: ['starting'], to: 'running' },
  /** The box is removed. Terminal. */
  delete: { from: NOT_DELETED, to: 'deleted' },
} as const satisfies Record<string, StatusRule<RuntimeStatus>>;

export type AppRuntimeTransition = keyof typeof APP_RUNTIME_TRANSITIONS;

/** Apply a runtime transition to the rows `where` selects. The moved rows. */
export function transitionAppRuntimes(
  transition: AppRuntimeTransition,
  where: SQL | undefined,
  set: PgUpdateSetSource<typeof appRuntimes> = {},
  exec: StatusExecutor = db,
): Promise<RuntimeRow[]> {
  return transitionStatusAll(appRuntimes, appRuntimes.status, APP_RUNTIME_TRANSITIONS[transition], { where, set }, exec);
}

/** Apply a runtime transition to one row. The moved row, or null on a lost race. */
export async function transitionAppRuntime(
  transition: AppRuntimeTransition,
  where: SQL | undefined,
  set: PgUpdateSetSource<typeof appRuntimes> = {},
  exec: StatusExecutor = db,
): Promise<RuntimeRow | null> {
  const moved = await transitionStatus(appRuntimes, appRuntimes.status, APP_RUNTIME_TRANSITIONS[transition], { where, set }, exec);
  return moved.applied ? moved.row : null;
}
