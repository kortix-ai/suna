import { redirect } from 'next/navigation';

/**
 * /workspaces/[id]/customize/review — Review's address from 2026-10-17 to
 * 2026-11-04. Review is its own page now (`/workspaces/[id]/review`); this
 * redirects there and keeps the query, so a shared `?id=<review item id>`
 * link still opens the same review.
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
  redirect(`/workspaces/${id}/review${suffix ? `?${suffix}` : ''}`);
}
