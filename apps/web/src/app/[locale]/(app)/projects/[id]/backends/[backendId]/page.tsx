import { redirect } from 'next/navigation';

import { backendHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { withSearch } from '@/features/workspace/capabilities/shared/with-search';

/** Retired route: one backend lives under the Customize Backends tab now. `kortix backends dashboard` links here. */
export default async function RetiredProjectBackendRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; backendId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, backendId } = await params;
  redirect(withSearch(backendHref(id, backendId), await searchParams));
}
