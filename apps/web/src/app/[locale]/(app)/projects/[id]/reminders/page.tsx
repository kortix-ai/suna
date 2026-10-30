import { capabilityTabHref } from '@kortix/ui/workspace';
import { withSearch } from '@kortix/ui/customize/shared/with-search';
import { redirect } from 'next/navigation';

/**
 * The Reminders page's address until 2026-10-19, when it was a sidebar row.
 * Notifications and the CLI still link here. It redirects to the Customize
 * Reminders tab and keeps the query (`?session=`, `?view=`, `?date=`).
 */
export default async function LegacyRemindersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  redirect(withSearch(capabilityTabHref(id, 'reminders'), query));
}
