/**
 * The lifecycle rows THIS process has claimed, so a shutdown can hand them back.
 *
 * A rollout's SIGTERM used to exit with rows still `running` under this
 * process's leases. Nothing could reclaim them until the 5-min lock and the
 * 5-min grace ran out (`claimDueLifecycleCommands`), and every later prompt of
 * the same session waited behind them (`hasInFlightPrompt`).
 *
 * A worker id cannot name the process (`process.pid` is 1 in every container),
 * so the drain records each lease it takes and forgets it when the row settles.
 */
import { type CommandLease } from './command-lease';
import { returnClaimToQueue } from './inbox-delivery-hold';

// replica-local: a process hands back only the claims it holds itself.
const held = new Map<string, CommandLease>();
let stopped = false;

/** True once a shutdown began: the drain claims nothing more. */
export function claimsStopped(): boolean {
  return stopped;
}

export function trackClaims(leases: CommandLease[]): void {
  for (const lease of leases) held.set(lease.commandId, lease);
}

export function forgetClaim(lease: CommandLease): void {
  if (held.get(lease.commandId)?.lockedBy === lease.lockedBy) held.delete(lease.commandId);
}

/**
 * Stop claiming, give in-flight rows up to `graceMs` to settle, then return
 * every row still held to the queue, due now. A delivery still running here
 * re-reads its claim before the POST (`assertInboxDeliveryActive`) and stops.
 */
export async function handBackClaims(graceMs = 5_000, sleep: (ms: number) => Promise<void> = Bun.sleep): Promise<number> {
  stopped = true;
  const deadline = Date.now() + graceMs;
  while (held.size > 0 && Date.now() < deadline) await sleep(100);
  const leases = [...held.values()];
  await Promise.all(leases.map((lease) => returnClaimToQueue(lease)));
  return leases.length;
}
