import { redirect } from 'next/navigation';

import { subprojectsHref } from '@/features/subprojects/subproject-runs';

/**
 * `/projects/[id]/subprojects` — retired, and kept only to forward.
 *
 * The store is the **Marketplace** capability tab now
 * (`/projects/[id]/marketplace`), under Customize with Models / Connectors /
 * Agents / Skills / Triggers. It had its own sidebar row and its own top-level
 * segment; both are gone, because installing a subproject is configuration, not
 * a place you navigate to.
 *
 * A server redirect rather than a `router.replace` effect — the target needs no
 * per-project data, so resolving it on the server means the browser never
 * paints a page it is about to leave. Same pattern as
 * `(capabilities)/channels/page.tsx`.
 *
 * Deleting the folder outright was the alternative and is the wrong one — a URL
 * that worked this morning would 404 this afternoon, silently, for anyone who
 * had saved it. `subprojects/runs` and `subprojects/runs/[subprojectSlug]` are
 * NOT retired and keep their URLs; only this index moved.
 */
export default async function RetiredProjectSubprojectsRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(subprojectsHref(id));
}
