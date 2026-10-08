import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ProviderName } from '../../platform/providers';

/** Any reference excludes orphan cleanup, even when its status is stale. */
export async function hasProviderBoxReference(provider: ProviderName, externalId: string): Promise<boolean> {
  const rows = await db.execute<{ referenced: boolean }>(sql`
    select exists (
      select 1 from kortix.session_sandboxes where provider = ${provider} and external_id = ${externalId}
      union all
      select 1 from kortix.app_runtimes where provider = ${provider} and external_id = ${externalId}
      union all
      select 1 from kortix.project_monitor_boxes where provider = ${provider} and external_id = ${externalId}
      union all
      select 1 from kortix.project_backends where provider = ${provider} and external_id = ${externalId}
    ) as referenced
  `);
  // No result is not proof of absence. A failed query throws before stop().
  return rows[0]?.referenced !== false;
}
