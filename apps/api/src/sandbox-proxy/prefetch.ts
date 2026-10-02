import type { Context } from 'hono';
import { type SandboxRecord, loadSandbox } from './backend';

// The sandbox row, read as soon as the caller is authenticated and within its
// rate limit (see `sandbox-proxy/index.ts` for the order), so the read
// overlaps the rest of the request instead of starting when `forwardToSandbox`
// needs it. The row is still read during THIS request, never cached: its
// status must be fresh, and it reaches nobody unless the checks in
// `forwardToSandbox` pass, exactly as before.

const PREFETCHED_SANDBOX = 'prefetchedSandbox';

type PrefetchedSandbox = { externalId: string; pending: Promise<SandboxRecord | null> };

/** Start reading `externalId`'s row for this request. */
export function prefetchSandbox(c: Context, externalId: string): void {
  const pending = loadSandbox(externalId);
  // A request that fails auth never takes it; the rejection must not escape.
  pending.catch(() => undefined);
  c.set(PREFETCHED_SANDBOX, { externalId, pending } satisfies PrefetchedSandbox);
}

/**
 * The row `prefetchSandbox` started for `externalId`, or undefined when there
 * is none or the read failed (the caller then reads it itself).
 */
export async function takePrefetchedSandbox(
  c: Context,
  externalId: string,
): Promise<SandboxRecord | undefined> {
  const prefetched = c.get(PREFETCHED_SANDBOX) as PrefetchedSandbox | undefined;
  if (!prefetched || prefetched.externalId !== externalId) return undefined;
  return (await prefetched.pending.catch(() => null)) ?? undefined;
}
