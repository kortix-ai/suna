// Idempotent migration of legacy kortix.project_secrets into the vault as
// project-owned "everyone" items, re-keyed from the legacy per-project envelope
// (v1) to the project vault envelope (v3). Runs at boot; skips rows present.
import { and, eq, isNull } from 'drizzle-orm';
import { projectSecrets, vaultItems } from '@kortix/db';
import { db } from '../shared/db';
import { decryptProjectSecret } from '../projects/secrets';
import { upsertProjectItem } from './repository';

export async function migrateProjectSecretsToVault(): Promise<void> {
  const rows = await db
    .select({
      projectId: projectSecrets.projectId,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      createdBy: projectSecrets.createdBy,
    })
    .from(projectSecrets);

  let migrated = 0;
  for (const r of rows) {
    const [existing] = await db
      .select({ itemId: vaultItems.itemId })
      .from(vaultItems)
      .where(and(eq(vaultItems.projectId, r.projectId), eq(vaultItems.name, r.name), isNull(vaultItems.ownerUserId)))
      .limit(1);
    if (existing) continue;

    let value: string;
    try {
      value = decryptProjectSecret(r.projectId, r.valueEnc);
    } catch {
      console.warn(`[vault-migrate] could not decrypt ${r.projectId}/${r.name} — skipping`);
      continue;
    }
    await upsertProjectItem({
      projectId: r.projectId,
      name: r.name,
      value,
      kind: 'env',
      ownerUserId: null,
      createdBy: r.createdBy ?? r.projectId,
    });
    migrated++;
  }
  if (migrated > 0) console.log(`[vault-migrate] migrated ${migrated} project secret(s) into the vault`);
}
