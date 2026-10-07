import { redirect } from 'next/navigation';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { withSearch } from '@/features/workspace/capabilities/shared/with-search';

/** Retired route: Backends is a Customize tab now. */
export default async function RetiredProjectBackendsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  redirect(withSearch(capabilityTabHref(id, 'backends'), await searchParams));
}
