import { capabilityTabHref } from '@kortix/ui/workspace';
import { redirect } from 'next/navigation';

/**
 * The Review Center's address from 2026-10-02 to 2026-10-17, when it was a
 * sidebar row. It redirects to the Customize Review tab and keeps the query,
 * so a shared `?id=<review item id>` link still opens the same review.
 */
export default async function LegacyReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      search.append(key, v);
    }
  }
  const suffix = search.toString();
  const href = capabilityTabHref(id, 'review');
  redirect(suffix ? `${href}?${suffix}` : href);
}
