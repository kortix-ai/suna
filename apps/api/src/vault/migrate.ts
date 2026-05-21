// One-time, idempotent migration of legacy kortix.project_secrets into the
// unified vault as project-scoped, account-owned, global env items. Re-keys
// each value from the legacy per-project envelope (v1) to the account envelope
// (v2). Run at boot after seeding; skips rows already present in the vault.
import { and, eq, isNull } from 'drizzle-orm';
import { projectSecrets, projects, vaultItems } from '@kortix/db';
import { db } from '../shared/db';
import { decryptProjectSecret } from '../projects/secrets';
import { upsertVaultItem } from './repository';

export async function migrateProjectSecretsToVault(): Promise<void> {
  const rows = await db
    .select({
      projectId: projectSecrets.projectId,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      createdBy: projectSecrets.createdBy,
      accountId: projects.accountId,
    })
    .from(projectSecrets)
    .innerJoin(projects, eq(projects.projectId, projectSecrets.projectId));

  let migrated = 0;
  for (const r of rows) {
    const [existing] = await db
      .select({ itemId: vaultItems.itemId })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.ownerAccountId, r.accountId),
          eq(vaultItems.projectId, r.projectId),
          isNull(vaultItems.ownerUserId),
          eq(vaultItems.name, r.name),
        ),
      )
      .limit(1);
    if (existing) continue; // already migrated — don't clobber

    let value: string;
    try {
      value = decryptProjectSecret(r.projectId, r.valueEnc);
    } catch {
      console.warn(`[vault-migrate] could not decrypt ${r.projectId}/${r.name} — skipping`);
      continue;
    }
    await upsertVaultItem({
      accountId: r.accountId,
      name: r.name,
      value,
      kind: 'env',
      projectId: r.projectId,
      ownerUserId: null,
      createdBy: r.createdBy ?? r.accountId,
    });
    migrated++;
  }
  if (migrated > 0) console.log(`[vault-migrate] migrated ${migrated} project secret(s) into the vault`);
}
