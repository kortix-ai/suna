/**
 * The optional secret-copy sub-job of a repository replacement: copy the
 * selected shared runtime secrets from another project into the target, under
 * the target's encryption key. Split out of `repository-replacement.ts`
 * (KRTX-1499); it runs INSIDE that replacement's transaction, so every refusal
 * below aborts the whole swap. The characterization tests pin each refusal
 * (repository-replacement.integration.test.ts).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { projects, projectSecrets } from '@kortix/db';
import * as iamAuthorize from '../../iam/authorize';
import { db } from '../../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from '../secrets';

/** The transaction handle the replacement's `db.transaction` callback passes in. */
type ReplacementTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class RepositorySecretCopyError extends Error {}

export type SharedSecretCopy = { sourceProjectId: string; identifiers: string[] };

export async function copySharedSecretsIntoProject(
  tx: ReplacementTx,
  copy: {
    sourceProjectId: string;
    identifiers: string[];
    targetProjectId: string;
    accountId: string;
    actorId: string;
    now: Date;
  },
): Promise<void> {
  const { sourceProjectId, identifiers } = copy;
  const unique = [...new Set(identifiers)];
  if (sourceProjectId === copy.targetProjectId || unique.length !== identifiers.length || unique.length === 0) {
    throw new RepositorySecretCopyError('Select distinct shared secret identifiers from another project');
  }
  const [source] = await tx.select({ accountId: projects.accountId, status: projects.status })
    .from(projects).where(eq(projects.projectId, sourceProjectId)).limit(1);
  if (!source || source.accountId !== copy.accountId || source.status !== 'active') {
    throw new RepositorySecretCopyError('Secret source project is not available in this account');
  }
  const sourceRows = await tx.select().from(projectSecrets).where(and(
    eq(projectSecrets.projectId, sourceProjectId),
    inArray(projectSecrets.identifier, unique),
    isNull(projectSecrets.ownerUserId),
  ));
  const sourceByIdentifier = new Map(sourceRows.map((row) => [row.identifier, row]));
  const existing = await tx.select({ identifier: projectSecrets.identifier }).from(projectSecrets).where(and(
    eq(projectSecrets.projectId, copy.targetProjectId),
    inArray(projectSecrets.identifier, unique),
    isNull(projectSecrets.ownerUserId),
  ));
  if (existing.length) throw new RepositorySecretCopyError(`Target already has ${existing[0]!.identifier}`);
  // A value narrowed to an audience stays in its project: a copy would be
  // open to everyone in the target (secret-audience.ts).
  const narrowed = await iamAuthorize.loadObjectGrants(sourceProjectId, 'secret');
  for (const identifier of unique) {
    const row = sourceByIdentifier.get(identifier);
    if (!row || !row.active) throw new RepositorySecretCopyError(`Source has no active shared ${identifier}`);
    if (narrowed.has(row.secretId)) {
      throw new RepositorySecretCopyError(`${identifier} is shared with specific people and cannot be copied`);
    }
    if (row.scope !== 'runtime' || row.strategy !== 'runtime' || identifier.toUpperCase().startsWith('KORTIX_') || identifier.toUpperCase() === 'CODEX_AUTH_JSON') {
      throw new RepositorySecretCopyError(`${identifier} cannot be copied with a repository replacement`);
    }
  }
  await tx.insert(projectSecrets).values(unique.map((identifier) => {
    const row = sourceByIdentifier.get(identifier)!;
    return {
      projectId: copy.targetProjectId, identifier, name: row.name,
      valueEnc: encryptProjectSecret(copy.targetProjectId, decryptProjectSecret(sourceProjectId, row.valueEnc)),
      scope: row.scope, strategy: row.strategy, consumer: row.consumer,
      description: row.description, createdBy: copy.actorId, updatedAt: copy.now,
    };
  }));
}
