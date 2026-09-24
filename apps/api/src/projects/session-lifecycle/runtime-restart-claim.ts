import { sessionSandboxes } from '@kortix/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { IN_PLACE_RESTART_CLEARED_KEYS, inPlaceRestartWakePatch } from './readiness-clocks';
import { runtimeRestartClaimMetadata, type RuntimeRestartClaim } from './runtime-restart-fence';
import { stripMetadataKeys } from './sandbox-metadata-sql';

/**
 * Install an in-place restart claim on a session sandbox row.
 *
 * The metadata predicate is the lifecycle lock. `/restart` returns before the
 * provider stop/start finishes, so an HTTP mutation's `isPending` flag cannot
 * serialize a second tab, a refresh, or a repeated click. Only one request may
 * install an unexpired restart id on this session.
 *
 * The write is computed in SQL from the row the UPDATE locks. It used to write
 * back a whole object built from a row read before the provider status call,
 * which erased any key written in between. The egress pin lands ~0.2 s before
 * a restart in SESS-9 (2026-09), so it is the key most exposed to that gap.
 *
 * Returns true when this call owns the restart.
 */
export async function claimInPlaceRestart(input: {
  sandboxId: string;
  externalId: string;
  claim: RuntimeRestartClaim;
}): Promise<boolean> {
  const { sandboxId, externalId, claim } = input;
  const patch = runtimeRestartClaimMetadata(inPlaceRestartWakePatch(claim.startedAt), claim);
  const [claimed] = await db
    .update(sessionSandboxes)
    .set({
      status: 'provisioning',
      metadata: sql`(${stripMetadataKeys(IN_PLACE_RESTART_CLEARED_KEYS)}) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: claim.startedAt,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.externalId, externalId),
        // A deleted session's archived row is never restarted.
        ne(sessionSandboxes.status, 'archived'),
        sql`(
          ${sessionSandboxes.metadata}->>'runtimeRestartId' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeRestartLeaseExpiresAt' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeRestartLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
          OR ${sessionSandboxes.metadata}->>'runtimeRestartLeaseExpiresAt' <= ${claim.startedAt.toISOString()}
        )`,
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  return Boolean(claimed);
}
