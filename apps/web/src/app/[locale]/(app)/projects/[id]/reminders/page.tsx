import { remindersHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { withSearch } from '@/features/workspace/capabilities/shared/with-search';
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
  redirect(withSearch(remindersHref(id), query));
}
