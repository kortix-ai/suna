import 'server-only';

import { getServerPublicEnv } from '@/lib/public-env-server';
import { runtimeConfigIsBakedAtBuild } from '@/lib/runtime-config-mode';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

/**
 * 404 for /services and /case-studies until SERVICES_PAGES_ENABLED is on
 * (`isServicesPagesEnabled`). Read at request time, as the root layout reads
 * the runtime config, so one image serves dev with the pages and prod without.
 */
export async function requireServicesPages(): Promise<void> {
  if (!runtimeConfigIsBakedAtBuild()) await connection();
  if (!getServerPublicEnv().SERVICES_PAGES_ENABLED) notFound();
}
