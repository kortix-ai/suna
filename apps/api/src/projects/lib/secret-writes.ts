/** Shared by the secret write routes: the write response, delivery-sync summary, and boundary checks. */
import { db } from '../../shared/db';
import { type ProjectSecretPropagationResult } from './sandbox-env-sync';
import { z } from '@hono/zod-openapi';
import { SecretSchema as ContractSecretSchema } from '@kortix/api-contract';
import {
  findBoundaryDestinationConflict,
  type BoundaryDestinationConflict,
} from '../../secrets/network-boundary';
import { connectors, projectSecrets, type SecretEgressPolicy } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';

// ─── Secret write responses ─────────────────────────────────────────────────
// A secret write may also have to reach every LIVE sandbox in the project. The
// two write routes that can move a network-boundary credential report what that
// fan-out actually did, because a save that stored fine and delivered nowhere
// otherwise looks identical to a save that worked. `delivery_sync` is null when
// no fan-out ran. It is NOT part of `SecretSchema` — a secret READ has no sync
// to report.

const SecretDeliverySyncSchema = z
  .object({
    ok: z.boolean(),
    targeted: z.number(),
    synced: z.number(),
    failed: z.number(),
    failures: z.array(
      z.object({
        session_id: z.string(),
        sandbox_id: z.string().nullable(),
        reason: z.string(),
      }),
    ),
  })
  .nullable()
  .optional();

export type SecretDeliverySync = NonNullable<z.infer<typeof SecretDeliverySyncSchema>>;

export const SecretWriteResultSchema = ContractSecretSchema.extend({
  delivery_sync: SecretDeliverySyncSchema,
}).openapi('SecretWriteResult');

/** Keep the per-sandbox reasons; drop the rows that succeeded. */
export function summarizeDeliverySync(result: ProjectSecretPropagationResult): SecretDeliverySync {
  return {
    ok: result.ok,
    targeted: result.targeted,
    synced: result.synced,
    failed: result.failed,
    failures: result.results
      .filter((target) => target.status === 'failed')
      .map((target) => ({
        session_id: target.session_id,
        sandbox_id: target.sandbox_id,
        reason: target.reason ?? 'sandbox sync failed',
      })),
  };
}

/**
 * The other network-boundary secret in this project that already claims one of
 * the candidate's (host, header) destinations, or null.
 *
 * Only LEGACY injection rows claim a destination, and one (host, header) pair
 * maps to one credential. A second claim is refused at session provision, so
 * the stored pair takes down every NEW session in the project with an error the
 * author cannot connect to their edit. Both write routes call this BEFORE the
 * row lands. Substitution-only rows name no header, claim nothing, and are
 * exempt — two of them on one host are legal.
 */
export async function boundaryDestinationConflict(
  projectId: string,
  identifier: string,
  policy: SecretEgressPolicy,
): Promise<BoundaryDestinationConflict | null> {
  const rows = await db
    .select({ identifier: projectSecrets.identifier, egressPolicy: projectSecrets.egressPolicy })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.strategy, 'egress'),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  return findBoundaryDestinationConflict(
    { identifier, policy },
    rows.map((other) => ({ identifier: other.identifier, policy: other.egressPolicy })),
  );
}

export function boundaryConflictBody(identifier: string, conflict: BoundaryDestinationConflict) {
  return {
    error:
      `${conflict.identifier} already injects the "${conflict.header}" header for ${conflict.host}. ` +
      `Two secrets cannot target the same host and header — give ${identifier} a different header, ` +
      'or a different host.',
    code: 'secret_boundary_destination_conflict',
    conflict,
  };
}

export async function connectorSecretBindings(projectId: string, identifier: string): Promise<string[]> {
  const rows = await db
    .select({ slug: connectors.slug })
    .from(connectors)
    .where(
      and(
        eq(connectors.projectId, projectId),
        eq(connectors.authSecret, identifier),
      ),
    );
  return rows.map((row) => row.slug).sort();
}
