import { reviewHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { redirect } from 'next/navigation';

/**
 * The Review Center's old address, from when it was a Customize tab
 * (2026-09-02 to 2026-10-02). It redirects to `/projects/[id]/review` and
 * keeps the query, so a shared `?id=<review item id>` link still opens the
 * same review.
 */
export default async function LegacyCustomizeReviewPage({
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
  redirect(suffix ? `${reviewHref(id)}?${suffix}` : reviewHref(id));
}
