import { redirect } from 'next/navigation';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { withSearch } from '@/features/workspace/capabilities/shared/with-search';

/** Retired route: Apps is a Customize tab now. Bookmarks and `?open_app=` links keep working. */
export default async function RetiredProjectAppsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  redirect(withSearch(capabilityTabHref(id, 'apps'), await searchParams));
}
