import { redirect } from 'next/navigation';

import { withSearch } from '@/features/workspace/capabilities/shared/with-search';

/** Retired tab: Apps is a sidebar page again (Marko, 2026-10-07). Links from the Customize era keep working. */
export default async function RetiredCustomizeAppsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  redirect(withSearch(`/projects/${id}/apps`, await searchParams));
}
