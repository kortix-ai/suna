/**
 * What account erasure deletes outside the database (KRTX-1734), split from
 * account-deletion.ts so its unit test can stub this step and keep testing the
 * sandbox reclaim; integration-account-erasure-stores.test.ts runs it for real.
 */
import { sessionSandboxes, projects } from '@kortix/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { tryGetProvider } from '../../platform/providers';
import {
  deleteManagedProjectRepo,
  isAlreadyNotRunning,
  sessionAttachmentStore,
} from '../../projects/surface';
import { db } from '../../shared/db';

/** Provider calls in flight at once, the same bound as the sandbox reclaim. */
const REMOVE_CONCURRENCY = 8;

/** Sandbox states the reclaim pass leaves alone: parked, but still on the provider's disk. */
const PARKED_SANDBOX_STATUSES = ['stopped', 'archived'] as const;

/**
 * The account's data outside our database that the row delete cannot reach
 * (KRTX-1734). A parked box keeps its disk at the provider (the reclaim pass
 * takes only running boxes), a project's session files stay in object storage,
 * and its Kortix-managed repo stays on the git host. Once the rows that name
 * them are gone nothing can find them again, so this runs while the rows exist
 * and throws on any failure: the request stays retryable instead of completed.
 * A repo the user connected is never touched (`deleteManagedProjectRepo`).
 */
export async function deleteAccountExternalStores(accountId: string): Promise<void> {
  const parked = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, [...PARKED_SANDBOX_STATUSES]),
        isNotNull(sessionSandboxes.externalId),
      ),
    );
  let failed = 0;
  for (let i = 0; i < parked.length; i += REMOVE_CONCURRENCY) {
    await Promise.all(
      parked.slice(i, i + REMOVE_CONCURRENCY).map(async (row) => {
        const provider = tryGetProvider(row.provider as string);
        if (!provider) {
          // Nothing on this deployment can remove it; retrying would block the
          // deletion for ever.
          logger.error(
            `[AccountDeletion] No provider client for ${row.provider}; parked sandbox ${row.sandboxId} stays at the provider`,
          );
          return;
        }
        try {
          await provider.remove(row.externalId as string);
        } catch (err) {
          if (isAlreadyNotRunning(err)) return;
          failed++;
          logger.error(`[AccountDeletion] Failed to remove parked sandbox ${row.sandboxId}:`, {
            error: err instanceof Error ? err.message : err,
          });
        }
      }),
    );
  }
  if (failed > 0) throw new Error(`${failed} parked sandbox(es) of account ${accountId} could not be removed`);

  for (const project of await db.select().from(projects).where(eq(projects.accountId, accountId))) {
    await sessionAttachmentStore().removeProject(project.projectId);
    await deleteManagedProjectRepo(project);
  }
}
