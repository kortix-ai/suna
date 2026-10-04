import { createHash, randomBytes } from 'node:crypto';
import { projectSessionSecretHandles, projectSessions } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { config } from '../../lib/config';
import type { SecretEgressPolicy } from './strategy';
import { mintHandle, newLookupId } from './strategy';
import { recordAuditEvent } from '../audit/audit';
import { db } from '../../lib/db';
import type { ResolvedProjectSecret } from './secrets';

/**
 * Reuse the current handle for this session+secret while its stored policy
 * matches and it has not expired; otherwise supersede it and mint the next
 * revision. Runs inside one transaction.
 */
async function renewOrMintSecretHandle(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  projectId: string,
  sessionId: string,
  row: ResolvedProjectSecret,
  egressPolicy: SecretEgressPolicy,
): Promise<{ handle: string; issued: boolean; accountId: string; revision: number }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${sessionId}:${row.secretId}`}, 0))`,
  );
  const [session] = await tx
    .select({ accountId: projectSessions.accountId })
    .from(projectSessions)
    .where(
      and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
    )
    .limit(1);
  if (!session) throw new Error('Cannot mint a secret handle without its project session');
  const [latest] = await tx
    .select()
    .from(projectSessionSecretHandles)
    .where(
      and(
        eq(projectSessionSecretHandles.sessionId, sessionId),
        eq(projectSessionSecretHandles.secretId, row.secretId),
      ),
    )
    .orderBy(desc(projectSessionSecretHandles.revision))
    .limit(1);
  const policyMatches =
    latest && JSON.stringify(latest.policySnapshot) === JSON.stringify(egressPolicy);
  const notExpired = !latest?.expiresAt || latest.expiresAt.getTime() > Date.now();
  if (latest?.status === 'active' && policyMatches && notExpired) {
    const handle = mintHandle({
      lookupId: latest.lookupId,
      prefix: row.handlePrefix,
      rootSecret: config.API_KEY_SECRET,
    });
    const hash = createHash('sha256').update(handle).digest('hex');
    if (hash !== latest.handleHash) {
      await tx
        .update(projectSessionSecretHandles)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(projectSessionSecretHandles.handleId, latest.handleId));
      throw new Error('Stored secret handle integrity check failed');
    }
    return {
      handle,
      issued: false,
      accountId: session.accountId,
      revision: latest.revision,
    };
  }
  if (latest?.status === 'active') {
    await tx
      .update(projectSessionSecretHandles)
      .set({ status: 'superseded' })
      .where(eq(projectSessionSecretHandles.handleId, latest.handleId));
  }
  const revision = (latest?.revision ?? 0) + 1;
  const lookupId = newLookupId(randomBytes(20));
  const handle = mintHandle({
    lookupId,
    prefix: row.handlePrefix,
    rootSecret: config.API_KEY_SECRET,
  });
  await tx.insert(projectSessionSecretHandles).values({
    projectId,
    sessionId,
    secretId: row.secretId,
    identifier: row.identifier,
    envName: row.key,
    lookupId,
    handleHash: createHash('sha256').update(handle).digest('hex'),
    revision,
    policySnapshot: egressPolicy,
    status: 'active',
  });
  return { handle, issued: true, accountId: session.accountId, revision };
}

export async function mintSessionSecretHandle(
  projectId: string,
  sessionId: string,
  row: ResolvedProjectSecret,
): Promise<string> {
  const egressPolicy = row.egressPolicy;
  if (!egressPolicy) throw new Error('Managed secret delivery requires a policy');

  const result = await db.transaction((tx) =>
    renewOrMintSecretHandle(tx, projectId, sessionId, row, egressPolicy),
  );

  if (result.issued) {
    await recordAuditEvent({
      accountId: result.accountId,
      projectId,
      sessionId,
      actorType: 'system',
      source: 'system',
      action: 'secret.handle.issued',
      resourceType: 'project_secret',
      resourceId: row.secretId,
      metadata: {
        identifier: row.identifier,
        // Derived, not hardcoded: this path now mints for egress-enforced rows
        // as well as broker rows, and an audit record that calls every handle
        // `http_broker` misattributes the delivery mode in the one record
        // anybody reads after an incident. Mirrors the same derivation in
        // routes/secret-broker.ts.
        consumer: row.consumer ?? (row.strategy === 'egress' ? 'network' : 'http_broker'),
        strategy: row.strategy ?? 'broker',
        revision: result.revision,
      },
    });
  }
  return result.handle;
}
